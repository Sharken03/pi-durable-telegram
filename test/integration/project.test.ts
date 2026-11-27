import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ChatMap } from "../../src/channel/docs.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir, testConfig } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(config: Record<string, string> = {}, faux = newFaux()) {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir, faux, port, config });
	cleanups.push(cleanup, () => t.close());
	return { t, port, dir, faux, workdir: testConfig(dir).workdir };
}

function replyTo(port: FakeTelegram, messageId: number): string | undefined {
	return port.created(CHAT).find((m) => m.replyTo === messageId)?.text;
}

/** The directory the chat's own agent works in; a topic has its own key and its own conversation. */
async function cwdOf(t: TestAgent, key = String(CHAT)): Promise<string | undefined> {
	const id = await waitFor(async () => (await t.agent.harness.snapshot(ChatMap, BG))?.chats[key]);
	const conversation = await t.agent.harness.conversation(id as never, BG);
	return (await conversation?.agent(BG))?.cwd;
}

test("/project shows the bot's directory until the chat sets its own", async () => {
	const { t, port, workdir } = await setup();
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/project"));
	await waitFor(() => replyTo(port, 1));
	assert.equal(replyTo(port, 1), `Project: ${workdir} (the default)`);
});

test("/project hub: the chat works in that directory, and the next run uses it", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("in hub")]);
	const { t, port, workdir } = await setup({}, faux);
	await mkdir(join(workdir, "hub"), { recursive: true });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/project hub"));
	await waitFor(() => replyTo(port, 1));
	assert.equal(replyTo(port, 1), `Project: ${join(workdir, "hub")}`);
	assert.equal(await cwdOf(t), join(workdir, "hub"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "work"));
	await waitFor(() => port.textsIn(CHAT).some((text) => text.startsWith("in hub")));
	assert.equal(await cwdOf(t), join(workdir, "hub"));
});

test("/project makes a new directory, and default goes back", async () => {
	const { t, port, workdir } = await setup();
	await mkdir(join(workdir, "hub"), { recursive: true });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/project hub"));
	await waitFor(() => replyTo(port, 1));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/project nyt/projekt"));
	await waitFor(() => replyTo(port, 2));
	assert.equal(replyTo(port, 2), `Project: ${join(workdir, "nyt/projekt")}`);
	assert.ok(existsSync(join(workdir, "nyt/projekt")), "the directory is made");
	assert.equal(await cwdOf(t), join(workdir, "nyt/projekt"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "/project default"));
	await waitFor(() => replyTo(port, 3));
	assert.equal(replyTo(port, 3), `Project: ${workdir} (the default)`);
	assert.equal(await cwdOf(t), workdir);
});

test("/project refuses a directory outside the bot's own, and a link that leaves it", async () => {
	const { t, port, workdir } = await setup();
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/project .."));
	await waitFor(() => replyTo(port, 1));
	assert.match(replyTo(port, 1) ?? "", /Only directories inside .* can be a project/);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/project /etc"));
	await waitFor(() => replyTo(port, 2));
	assert.match(replyTo(port, 2) ?? "", /Only directories inside .* can be a project/);
	// A file is refused too, so a chat cannot be pointed at something that is not a directory.
	await writeFile(join(workdir, "notadir"), "x");
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "/project notadir"));
	await waitFor(() => replyTo(port, 3));
	assert.equal(replyTo(port, 3), `${join(workdir, "notadir")} is not a directory.`);
	// A link inside the directory that points out of it is not a way out either.
	await symlink("/etc", join(workdir, "escape"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 4, "/project escape"));
	await waitFor(() => replyTo(port, 4));
	assert.match(replyTo(port, 4) ?? "", /Only directories inside .* can be a project/);
	assert.equal(await cwdOf(t), workdir);
});

test("/project survives a restart; a project that was deleted falls back to the bot's directory", async () => {
	const first = await setup();
	await mkdir(join(first.workdir, "hub"), { recursive: true });
	await first.t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/project hub"));
	await waitFor(() => replyTo(first.port, 1));
	await first.t.close();

	// Same data directory and workdir, new process: the stored project is applied again.
	const port = new FakeTelegram();
	const second = await startTestAgent({ dir: first.dir, faux: newFaux(), port, config: {} });
	cleanups.push(() => second.close());
	await second.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/project"));
	await waitFor(() => replyTo(port, 2));
	assert.equal(replyTo(port, 2), `Project: ${join(first.workdir, "hub")}`);
	await second.close();

	// A project directory that is gone must not leave the chat unable to work.
	await rm(join(first.workdir, "hub"), { recursive: true, force: true });
	const third = new FakeTelegram();
	const again = await startTestAgent({ dir: first.dir, faux: newFaux(), port: third, config: {} });
	cleanups.push(() => again.close());
	await again.agent.channel.handleUpdate(textUpdate(CHAT, 3, "/project"));
	await waitFor(() => replyTo(third, 3));
	assert.equal(replyTo(third, 3), `Project: ${first.workdir} (the default)`);
});

test("/project in one topic leaves the other topic and General in the bot's directory", async () => {
	const { t, port, workdir } = await setup();
	await mkdir(join(workdir, "hub"), { recursive: true });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/project hub", { threadId: 21 }));
	await waitFor(() => replyTo(port, 1));
	assert.equal(await cwdOf(t, `${CHAT}:21`), join(workdir, "hub"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/project", { threadId: 22 }));
	await waitFor(() => replyTo(port, 2));
	assert.equal(replyTo(port, 2), `Project: ${workdir} (the default)`);
	assert.equal(await cwdOf(t, `${CHAT}:22`), workdir);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "/project"));
	await waitFor(() => replyTo(port, 3));
	assert.equal(replyTo(port, 3), `Project: ${workdir} (the default)`);
	assert.equal(await cwdOf(t), workdir);
});
