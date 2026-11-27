import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ChatMap, ChatSettings } from "../../src/channel/docs.ts";
import { projectSection } from "../../src/channel/extension.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir, testConfig } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The phone's projects root that `/project` resolves names against. */
const PHONE = "/data/data/com.termux/files/home/projekter";

async function setup(
	config: Record<string, string> = {},
	faux = newFaux(),
	pluginEnv: Record<string, string> = {},
) {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	const t = await startTestAgent({
		dir,
		faux,
		port,
		config: { PI_PHONE_PROJECTS: PHONE, ...config },
		deps: { pluginEnv },
	});
	cleanups.push(cleanup, () => t.close());
	return { t, port, dir, faux, workdir: testConfig(dir).workdir };
}

function replyTo(port: FakeTelegram, messageId: number): string | undefined {
	return port.created(CHAT).find((m) => m.replyTo === messageId)?.text;
}

/** The chat's stored project, and the directory its own agent works in. */
async function stateOf(t: TestAgent, key = String(CHAT)): Promise<{ project?: string; cwd?: string }> {
	const id = await waitFor(async () => (await t.agent.harness.snapshot(ChatMap, BG))?.chats[key]);
	const conversation = await t.agent.harness.conversation(id as never, BG);
	const settings = await t.agent.harness.snapshot(ChatSettings, id as never, BG);
	return { project: settings?.project, cwd: (await conversation?.agent(BG))?.cwd };
}

test("/project shows the phone's projects root until the chat sets its own", async () => {
	const { t, port } = await setup();
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/project"));
	await waitFor(() => replyTo(port, 1));
	assert.equal(replyTo(port, 1), `Project: ${PHONE} (the default)`);
});

test("/project hub: the chat's project is a directory on the phone, and the bot stays in its own", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("in hub")]);
	const { t, port, workdir } = await setup({}, faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/project hub"));
	await waitFor(() => replyTo(port, 1));
	assert.equal(replyTo(port, 1), `Project: ${PHONE}/hub`);
	const state = await stateOf(t);
	assert.equal(state.project, `${PHONE}/hub`, "the phone path is what the chat keeps");
	assert.equal(state.cwd, workdir, "the bot's own tools keep working in the bot's directory");
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "work"));
	await waitFor(() => port.textsIn(CHAT).some((text) => text.startsWith("in hub")));
	assert.equal((await stateOf(t)).project, `${PHONE}/hub`);
});

test("/project default goes back to the root", async () => {
	const { t, port } = await setup();
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/project hub"));
	await waitFor(() => replyTo(port, 1));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/project default"));
	await waitFor(() => replyTo(port, 2));
	assert.equal(replyTo(port, 2), `Project: ${PHONE} (the default)`);
	assert.equal((await stateOf(t)).project, undefined);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "/project"));
	await waitFor(() => replyTo(port, 3));
	assert.equal(replyTo(port, 3), `Project: ${PHONE} (the default)`);
});

test("/project refuses a path outside the phone's projects root", async () => {
	const { t, port } = await setup();
	for (const [id, path] of [
		[1, ".."],
		[2, "/etc"],
		[3, "/data/data/com.termux/files/home/.ssh"],
	] as const) {
		await t.agent.channel.handleUpdate(textUpdate(CHAT, id, `/project ${path}`));
		await waitFor(() => replyTo(port, id));
		assert.match(replyTo(port, id) ?? "", /Only directories inside .* on the phone can be a project/);
	}
	assert.equal((await stateOf(t)).project, undefined, "nothing was stored");
});

test("/project asks the phone to make a directory that is not there yet", async () => {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
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
				params?: { name?: string; arguments?: Record<string, unknown> };
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
			calls.push({ name: message.params?.name ?? "?", args: message.params?.arguments ?? {} });
			send({ jsonrpc: "2.0", id: ++id, result: { content: [{ type: "text", text: "{\"created\":true}" }] } });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const port = (server.address() as AddressInfo).port;
	const { t, port: telegram } = await setup({ PI_PLUGINS: "workers" }, newFaux(), {
		PI_WORKERS_URL: `http://127.0.0.1:${port}/mcp`,
		PI_WORKERS_TOKEN: "t",
	});
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/project nyt/projekt"));
	await waitFor(() => replyTo(telegram, 1), { what: "the answer to /project" });
	assert.equal(replyTo(telegram, 1), `Project: ${PHONE}/nyt/projekt`);
	assert.deepEqual(calls.at(-1), { name: "make_project_dir", args: { path: `${PHONE}/nyt/projekt` } });
});

test("/project survives a restart, and one topic does not see another's project", async () => {
	const { t, port } = await setup();
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/project hub"));
	await waitFor(() => replyTo(port, 1));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/project varmehub", { threadId: 21 }));
	await waitFor(() => replyTo(port, 2));
	assert.equal(replyTo(port, 2), `Project: ${PHONE}/varmehub`);
	assert.equal((await stateOf(t, `${CHAT}:21`)).project, `${PHONE}/varmehub`);
	assert.equal((await stateOf(t, String(CHAT))).project, `${PHONE}/hub`, "the General chat keeps its own");
});

test("the section names the phone directory, and the root while the chat has no project", async () => {
	const section = projectSection(PHONE);
	const read = (project?: string) => ({ read: { snapshot: async () => (project === undefined ? undefined : { project }) } });
	const withProject = await section.render({ ...read(`${PHONE}/varmehub`), conversationId: "c1" } as never, BG as never);
	assert.match(withProject ?? "", new RegExp(`directory ${PHONE}/varmehub on the phone`));
	assert.match(withProject ?? "", /prefixed mcp__agent8t__/);
	assert.match(withProject ?? "", /edit_project_file/);
	const without = await section.render({ ...read(), conversationId: "c1" } as never, BG as never);
	assert.match(without ?? "", new RegExp(`directory ${PHONE} on the phone`));
});
