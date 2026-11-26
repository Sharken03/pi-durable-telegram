import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type FauxProviderHandle, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { ChatMap } from "../../src/channel/docs.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastToolResult, observe, textOf, toolCall } from "../helpers/faux-steps.ts";
import { pngBytes } from "../helpers/images.ts";
import { textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
	faux: FauxProviderHandle,
	uploadBytes?: number,
): Promise<{ t: TestAgent; port: FakeTelegram; work: string }> {
	const { dir, cleanup } = await tempDir();
	const work = join(dir, "work");
	await mkdir(work, { recursive: true });
	const port = new FakeTelegram();
	const t = await startTestAgent({
		dir,
		faux,
		port,
		deps: uploadBytes === undefined ? {} : { limits: { uploadBytes } },
	});
	cleanups.push(cleanup, () => t.close());
	return { t, port, work };
}

type Seen = { isError: boolean; text: string; images: string[] };

function inspect(messages: readonly Message[]): Seen {
	const result = lastToolResult(messages);
	const images = (result?.content ?? []).flatMap((part) => (part.type === "image" ? [part.mimeType] : []));
	return { isError: result?.isError === true, text: textOf(result), images };
}

test("T-image-inject: read of an image attaches its bytes per request; history keeps only text", async () => {
	const faux = newFaux();
	const seen: Seen[] = [];
	faux.setResponses([
		toolCall("read", { path: "inbox/pic.png" }),
		(context) => {
			seen.push(inspect(context.messages));
			return fauxAssistantMessage("I see a black square");
		},
	]);
	const { t, port, work } = await setup(faux);
	await mkdir(join(work, "inbox"), { recursive: true });
	await writeFile(join(work, "inbox", "pic.png"), pngBytes(64, 48));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "look"));
	await waitFor(() => port.textsIn(CHAT).includes("I see a black square"));
	assert.equal(seen[0]?.isError, false);
	assert.deepEqual(seen[0]?.images, ["image/png"]);
	assert.match(seen[0]?.text ?? "", /pic\.png \(64x48, 0\.0 MB\) is attached for viewing/);
	const id = (await t.agent.harness.snapshot(ChatMap, BG))?.chats[String(CHAT)];
	const conversation = await t.agent.harness.conversation(id as never, BG);
	assert.ok(conversation !== undefined);
	const view = await conversation.context(BG);
	const stored = JSON.stringify(view.messages);
	assert.ok(!stored.includes('"type":"image"'), "no image bytes in durable history");
});

test("T-image-validate: an oversized image is a model-readable error, not an attachment; text files read normally", async () => {
	const faux = newFaux();
	const seen: Seen[] = [];
	faux.setResponses([
		toolCall("read", { path: "huge.png" }),
		observe((messages) => seen.push(inspect(messages)), toolCall("read", { path: "notes.txt" })),
		observe((messages) => seen.push(inspect(messages)), fauxAssistantMessage("done")),
	]);
	const { t, port, work } = await setup(faux);
	await writeFile(join(work, "huge.png"), pngBytes(9000, 10));
	await writeFile(join(work, "notes.txt"), "plain notes");
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "look"));
	await waitFor(() => port.textsIn(CHAT).includes("done"));
	assert.equal(seen[0]?.isError, true);
	assert.match(seen[0]?.text ?? "", /Image too large to view .*9000x10.*Downscale/s);
	assert.deepEqual(seen[0]?.images, []);
	assert.equal(seen[1]?.isError, false);
	assert.match(seen[1]?.text ?? "", /plain notes/);
});

test("T-send-file-limits: missing, directory and oversized files are tool errors; images go as photos", async () => {
	const faux = newFaux();
	const seen: Seen[] = [];
	const step = (next: ReturnType<typeof toolCall>) => observe((messages) => seen.push(inspect(messages)), next);
	faux.setResponses([
		toolCall("telegram_send_file", { path: "missing.txt" }),
		step(toolCall("telegram_send_file", { path: "." })),
		step(toolCall("telegram_send_file", { path: "big.bin" })),
		step(toolCall("telegram_send_file", { path: "pic.png", caption: "the picture" })),
		step(toolCall("telegram_send_file", { path: "report.txt" })),
		observe((messages) => seen.push(inspect(messages)), fauxAssistantMessage("sent")),
	]);
	const { t, port, work } = await setup(faux, 1000);
	await writeFile(join(work, "big.bin"), Buffer.alloc(2000));
	await writeFile(join(work, "pic.png"), pngBytes(16, 16));
	await writeFile(join(work, "report.txt"), "report");
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "send"));
	await waitFor(() => port.textsIn(CHAT).includes("sent"));
	assert.deepEqual(
		seen.map((s) => s.isError),
		[true, true, true, false, false],
	);
	assert.match(seen[0]?.text ?? "", /File not found/);
	assert.match(seen[1]?.text ?? "", /not a regular file/);
	assert.match(seen[2]?.text ?? "", /Telegram bots can send at most 0\.0 MB/);
	assert.match(seen[3]?.text ?? "", /Sent pic\.png .* as photo/);
	assert.match(seen[4]?.text ?? "", /Sent report\.txt .* as document/);
	const photo = port.created(CHAT).find((m) => m.kind === "photo");
	assert.equal(photo?.caption, "the picture");
	assert.equal(port.created(CHAT).filter((m) => m.kind === "document").length, 1);
});

/** Tool names a request offers, from the system messages' tool changes. */
function toolNames(messages: readonly Message[]): string[] {
	const names = new Set<string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) names.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
	}
	return [...names];
}

test("T-no-bash: the agent has no shell tool; a bash call is an error and runs nothing", async () => {
	const faux = newFaux();
	const { t, port, work } = await setup(faux);
	const marker = join(work, "ran");
	let tools: string[] = [];
	let seen: Seen | undefined;
	faux.setResponses([
		(context) => {
			tools = toolNames(context.messages);
			return toolCall("bash", { command: `touch ${marker}` });
		},
		observe((messages) => {
			seen = inspect(messages);
		}, fauxAssistantMessage("ok")),
	]);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "run a command"));
	await waitFor(() => port.textsIn(CHAT).includes("ok"));
	assert.ok(["read", "write", "edit"].every((name) => tools.includes(name)), "file tools are offered");
	assert.ok(!tools.includes("bash"), "no bash tool is offered");
	assert.equal(seen?.isError, true);
	assert.ok(!existsSync(marker), "the command did not run");
});

test("T-path-guard: read, write, edit and send_file stay in the working directory, also through .. and symlinks", async () => {
	const faux = newFaux();
	const { t, port, work } = await setup(faux);
	const outside = join(work, "..", "outside.txt");
	await writeFile(outside, "private");
	await symlink(outside, join(work, "link.txt"));
	await symlink(join(work, ".."), join(work, "up"));
	await symlink(join(work, "..", "made.txt"), join(work, "dangling.txt"));
	await mkdir(join(work, "inbox", "2026-11-26"), { recursive: true });
	await writeFile(join(work, "inbox", "2026-11-26", "1-note.txt"), "from the user");
	const calls: [string, Record<string, unknown>][] = [
		["read", { path: outside }],
		["read", { path: "../outside.txt" }],
		["read", { path: "link.txt" }],
		["read", { path: "up/outside.txt" }],
		["write", { path: "link.txt", content: "changed" }],
		["edit", { path: "link.txt", edits: [{ oldText: "private", newText: "changed" }] }],
		["write", { path: "dangling.txt", content: "made" }],
		["write", { path: "../made.txt", content: "made" }],
		["telegram_send_file", { path: outside }],
		["telegram_send_file", { path: "link.txt" }],
		["write", { path: "new/sub/file.txt", content: "inside" }],
		["read", { path: "inbox/2026-11-26/1-note.txt" }],
		["read", { path: `${work}/new/../new/sub/file.txt` }],
	];
	const seen: Seen[] = [];
	faux.setResponses([
		...calls.map(([name, args], index) =>
			index === 0 ? toolCall(name, args) : observe((m) => seen.push(inspect(m)), toolCall(name, args)),
		),
		observe((m) => seen.push(inspect(m)), fauxAssistantMessage("checked")),
	]);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "try the paths"));
	await waitFor(() => port.textsIn(CHAT).includes("checked"), { what: "the last answer" });
	const refused = calls.length - 3;
	for (const [index, [name, args]] of calls.entries()) {
		const result = seen[index];
		if (index < refused) {
			assert.equal(result?.isError, true, `${name} ${args.path} is refused`);
			assert.equal(result?.text, `Path is outside the working directory: ${args.path}`);
		} else assert.equal(result?.isError, false, `${name} ${args.path} is allowed: ${result?.text}`);
	}
	assert.equal(await readFile(outside, "utf8"), "private", "the file outside is unchanged");
	assert.ok(!existsSync(join(work, "..", "made.txt")), "no file is made outside");
	assert.equal(await readFile(join(work, "new", "sub", "file.txt"), "utf8"), "inside");
	assert.match(seen.at(-2)?.text ?? "", /from the user/);
	assert.equal(port.created(CHAT).filter((m) => m.kind === "document").length, 0, "nothing was sent");
});
