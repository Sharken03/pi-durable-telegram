import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastUserText } from "../helpers/faux-steps.ts";
import { textUpdate } from "../helpers/updates.ts";

/** A stand-in for the phone's home-agent: the MCP handshake and the tools the workers plugin calls. */
type Fake = { url: string; calls: { name: string; args: Record<string, unknown> }[]; close(): Promise<void> };

async function fakeHomeAgent(options: { statuses?: string[] } = {}): Promise<Fake> {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const statuses = [...(options.statuses ?? ["running", "running", "done"])];
	const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
		start_agent: (args) => ({ id: "w1", cwd: String(args.cwd ?? "/work"), model: "deepseek/deepseek-flash", status: "running" }),
		agent_status: (args) => {
			if (args.worker_id === undefined) return { running: 0, max: 2, workers: [] };
			const status = statuses.length > 1 ? statuses.shift() : statuses[0];
			return { id: args.worker_id, status, seconds: 4, ...(status === "done" ? { exit: 0 } : {}) };
		},
		agent_result: () => '<worker_log id="w1" status="done" exit="0">\nWORKER OK\n</worker_log>',
		stop_agent: () => ({ id: "w1", status: "stopped" }),
		send_to_agent: () => ({ id: "w1", status: "running" }),
	};
	let nextId = 0;
	const server: Server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += String(chunk);
		});
		request.on("end", () => {
			const message = JSON.parse(body === "" ? "{}" : body) as {
				id?: number;
				method?: string;
				params?: { name?: string; arguments?: Record<string, unknown> };
			};
			const send = (payload: unknown) => {
				response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "test-session" });
				response.end(JSON.stringify(payload));
			};
			if (message.method === "initialize") {
				send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
				return;
			}
			if (message.method === "notifications/initialized") {
				response.writeHead(202);
				response.end();
				return;
			}
			const name = message.params?.name ?? "";
			const args = message.params?.arguments ?? {};
			calls.push({ name, args });
			const answer = answers[name];
			if (answer === undefined) {
				send({ jsonrpc: "2.0", id: ++nextId, result: { content: [{ type: "text", text: "no such tool" }], isError: true } });
				return;
			}
			const result = answer(args);
			send({
				jsonrpc: "2.0",
				id: ++nextId,
				result: { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] },
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		calls,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
	fake: Fake,
	options: { threadId?: number } = {},
): Promise<{ t: TestAgent; port: FakeTelegram; seen: string[] }> {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	const seen: string[] = [];
	const faux = newFaux();
	// One router for every request: the wake, the tool result and the first message are told apart by what arrived,
	// so extra turns (a retried request, for instance) do not run off the end of a fixed list.
	const step = (context: { messages: readonly Message[] }) => {
		const messages = context.messages;
		const last = messages.at(-1);
		const user = lastUserText(messages);
		seen.push(user);
		if (user.startsWith("[worker")) return fauxAssistantMessage("Got it.");
		if (last?.role === "toolResult") return fauxAssistantMessage("Started w1.");
		return fauxAssistantMessage([fauxToolCall("start_worker", { task: "read README", cwd: "/work/hub" }, { id: "c1" })], {
			stopReason: "toolUse",
		});
	};
	faux.setResponses(Array.from({ length: 40 }, () => step));
	const t = await startTestAgent({
		dir,
		faux,
		port,
		config: { PI_PLUGINS: "workers" },
		deps: {
			pluginEnv: {
				PI_WORKERS_URL: fake.url,
				PI_WORKERS_TOKEN: "test-token",
				PI_WORKERS_POLL_MS: "100",
			},
		},
	});
	cleanups.push(cleanup, () => t.close());
	return { t, port, seen };
}

const toolResult = (port: FakeTelegram): string => port.textsIn(CHAT).join("\n");

test("start_worker starts on the phone and the result lands in the chat by itself", async () => {
	const fake = await fakeHomeAgent();
	cleanups.push(() => fake.close());
	const { t, port, seen } = await setup(fake);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "start a worker in hub"));
	await waitFor(() => port.textsIn(CHAT).includes("Got it."), { what: "the worker's result as a message" });
	const names = fake.calls.map((call) => call.name);
	assert.equal(names[0], "start_agent", "it starts once");
	assert.equal(names.at(-1), "agent_result", "it reads the log when the worker is done");
	assert.ok(
		names.filter((name) => name === "agent_status").length >= 2,
		`it polls while the worker runs: ${names.join(", ")}`,
	);
	assert.equal(fake.calls[0]?.args.cwd, "/work/hub", "the directory is passed through");
	assert.ok(
		port.textsIn(CHAT).includes("Started w1."),
		`the chat is told the worker started: ${JSON.stringify(port.textsIn(CHAT))}`,
	);
	assert.match(seen[2] ?? "", /^\[worker w1 done, 4s, \/work\/hub\]/, "the wake names the worker, its time and directory");
	assert.match(seen[2] ?? "", /<worker_log[^>]*>\nWORKER OK/, "the log arrives as framed data");
	assert.equal(port.created(CHAT).at(-1)?.threadId, undefined, "the general chat has no thread");
});

test("in a topic the worker's result arrives in that topic", async () => {
	const fake = await fakeHomeAgent({ statuses: ["running", "done"] });
	cleanups.push(() => fake.close());
	const { t, port } = await setup(fake, { threadId: 21 });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "start a worker in hub", { threadId: 21 }));
	await waitFor(() => port.created(CHAT).some((message) => message.text === "Got it."), { what: "the answer" });
	const answer = port.created(CHAT).find((message) => message.text === "Got it.");
	assert.equal(answer?.threadId, 21, "the wake belongs to the topic that started the worker");
});

test("worker_status, worker_result, worker_send and worker_stop reach the phone", async () => {
	const fake = await fakeHomeAgent({ statuses: ["done"] });
	cleanups.push(() => fake.close());
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	const faux = newFaux();
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("worker_status", {}, { id: "s1" }),
				fauxToolCall("worker_result", { worker_id: "w1", lines: 5 }, { id: "r1" }),
				fauxToolCall("worker_send", { worker_id: "w1", text: "again" }, { id: "m1" }),
				fauxToolCall("worker_stop", { worker_id: "w1" }, { id: "x1" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	const t = await startTestAgent({
		dir,
		faux,
		port,
		config: { PI_PLUGINS: "workers" },
		deps: { pluginEnv: { PI_WORKERS_URL: fake.url, PI_WORKERS_TOKEN: "t", PI_WORKERS_POLL_MS: "100" } },
	});
	cleanups.push(cleanup, () => t.close());
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "how is it going"));
	await waitFor(() => port.textsIn(CHAT).includes("done"), { what: "the answer" });
	assert.deepEqual(
		[...new Set(fake.calls.map((call) => call.name))].sort(),
		["agent_result", "agent_status", "send_to_agent", "stop_agent"],
	);
	assert.equal(fake.calls.find((call) => call.name === "agent_result")?.args.worker_id, "w1");
	assert.deepEqual(fake.calls.find((call) => call.name === "agent_result")?.args, { worker_id: "w1", lines: 5 });
});

test("without a token the plugin says so and registers no worker tools", async () => {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	const t = await startTestAgent({
		dir,
		faux: newFaux(),
		port,
		config: { PI_PLUGINS: "workers" },
		deps: { pluginEnv: { PI_WORKERS_TOKEN: "" } },
	});
	cleanups.push(cleanup, () => t.close());
	assert.match(t.logs.join("\n"), /workers.*no token|no token.*workers/s, "the problem is reported once");
});
