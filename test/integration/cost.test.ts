import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { textUpdate } from "../helpers/updates.ts";

/** The phone's home-agent, cut down to `get_balances` and the handshake the client needs. */
type Phone = { url: string; calls: string[]; close(): Promise<void> };

async function phone(answer: unknown): Promise<Phone> {
	const calls: string[] = [];
	let id = 0;
	const server: Server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += String(chunk);
		});
		request.on("end", () => {
			const message = JSON.parse(body === "" ? "{}" : body) as {
				id?: number;
				method?: string;
				params?: { name?: string };
			};
			const send = (payload: unknown) => {
				response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" });
				response.end(JSON.stringify(payload));
			};
			if (message.method === "initialize") {
				send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
				return;
			}
			if (message.method === "notifications/initialized") {
				response.writeHead(202);
				response.end();
				return;
			}
			calls.push(message.params?.name ?? "?");
			send({
				jsonrpc: "2.0",
				id: ++id,
				result: { content: [{ type: "text", text: JSON.stringify(answer) }] },
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

const BALANCES = [
	{ account: "deepseek", balance: "DS: $21.13", age_seconds: 0 },
	{ account: "openrouter", balance: "OR: $0.21", age_seconds: 0 },
	{ account: "openrouter_free", balance: "OR: 135/1000 (01:00)", age_seconds: 0 },
	{ account: "claude", balance: "Claude: 5h 0% · 7d 100% (Mon 04:00)", age_seconds: 187 },
	{ account: "claude_2", balance: "Claude 2: login expired" },
	{ account: "agy", balance: "agy: Gemini 99% · Claude/GPT 0% (Wed 16:49)", age_seconds: 0 },
];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(pluginEnv: Record<string, string>): Promise<{ t: TestAgent; port: FakeTelegram }> {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	const t = await startTestAgent({
		dir,
		faux: newFaux(),
		port,
		config: { PI_PLUGINS: "workers" },
		deps: { pluginEnv },
	});
	cleanups.push(cleanup, () => t.close());
	return { t, port };
}

test("/cost shows the balances, the plans and the weekly quota from the phone", async () => {
	const fake = await phone(BALANCES);
	cleanups.push(() => fake.close());
	const { t, port } = await setup({ PI_WORKERS_URL: fake.url, PI_WORKERS_TOKEN: "t" });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/cost"));
	await waitFor(() => port.textsIn(CHAT).length > 0, { what: "the answer to /cost" });
	assert.equal(
		port.textsIn(CHAT)[0],
		[
			"DS: $21.13 · OR: $0.21 · OR: 135/1000 (01:00)",
			"Claude: 5h 0% · 7d 100% (Mon 04:00)",
			"Claude 2: login expired",
			"agy: Gemini 99% · Claude/GPT 0% (Wed 16:49)",
		].join("\n"),
	);
	assert.deepEqual(fake.calls, ["get_balances"], "one call, nothing else");
});

test("/cost marks an account the phone could not read", async () => {
	const fake = await phone([{ account: "deepseek", balance: "DS: $5.00" }, { account: "claude", error: "TimeoutExpired" }]);
	cleanups.push(() => fake.close());
	const { t, port } = await setup({ PI_WORKERS_URL: fake.url, PI_WORKERS_TOKEN: "t" });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/cost"));
	await waitFor(() => port.textsIn(CHAT).length > 0, { what: "the answer" });
	const text = port.textsIn(CHAT)[0] ?? "";
	assert.match(text, /^DS: \$5\.00 · OR: \? · OR: \?$/m, "a missing account is a question mark");
	assert.match(text, /^Claude: \?$/m);
	assert.match(text, /^Claude 2: \?$/m);
});

test("/cost says so when the plugin is off", async () => {
	const { t, port } = await setup({});
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/cost"));
	await waitFor(() => port.textsIn(CHAT).length > 0, { what: "the answer" });
	// The plugin reports the missing token as a notice, and /cost has nothing to ask.
	assert.match(port.textsIn(CHAT).join("\n"), /no token|No phone connection/);
});
