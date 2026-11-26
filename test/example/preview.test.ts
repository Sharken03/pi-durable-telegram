import assert from "node:assert/strict";
import { test } from "node:test";
import { DRAFT_REFRESH_MS, PreviewStreamer, renderPreview } from "../../src/delivery/preview.ts";
import { THINKING } from "../../src/format/rich.ts";
import { silentLogger } from "../../src/runtime/log.ts";
import { TelegramApiError } from "../../src/telegram/errors.ts";
import { sleep, waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";

test("preview render: call lines first, then the tail with the open fence reopened", () => {
	assert.equal(renderPreview({ text: "abc", status: "⚙ `read: a.ts`" }), "⚙ `read: a.ts`\n\nabc");
	const long = `\`\`\`ts\n${"x\n".repeat(3000)}`;
	const out = renderPreview({ text: long, status: "" });
	assert.ok(out.startsWith("```ts\n…"));
	assert.ok(out.length < 3600);
});

test("T-preview-cooldown: one message, throttled edits, 429 drops a frame and sets a cooldown", async () => {
	const port = new FakeTelegram();
	const created: number[] = [];
	let throttled = 0;
	port.use((call) => {
		if (call.method === "editMessageText" && throttled === 0) {
			throttled += 1;
			throw new TelegramApiError("editMessageText", 429, "Too Many Requests", 1);
		}
	});
	const streamer = new PreviewStreamer({
		port,
		chatId: 5,
		replyTo: 9,
		log: silentLogger,
		messageId: undefined,
		onCreated: async (id) => void created.push(id),
		intervalMs: 30,
	});
	streamer.push({ text: "one", status: "" });
	await waitFor(() => created.length === 1, { what: "preview created" });
	streamer.push({ text: "two", status: "" });
	await waitFor(() => throttled === 1, { what: "429" });
	streamer.push({ text: "three", status: "" });
	await sleep(400);
	assert.equal(port.textsIn(5)[0], "one", "no edit during the cooldown");
	await waitFor(() => port.textsIn(5)[0] === "three", { timeoutMs: 3000, what: "edit after cooldown" });
	await streamer.close();
	assert.equal(port.count("sendMessage"), 1);
	assert.equal(port.created(5).length, 1);
	assert.equal(port.created(5)[0]?.replyTo, 9);
});

test("preview reuses an existing message and treats 'not modified' as success", async () => {
	const port = new FakeTelegram();
	const id = await port.sendMessage(5, "old", {});
	const streamer = new PreviewStreamer({
		port,
		chatId: 5,
		replyTo: 1,
		log: silentLogger,
		messageId: id,
		onCreated: async () => assert.fail("must not create"),
		intervalMs: 10,
	});
	streamer.push({ text: "old", status: "" });
	streamer.push({ text: "new", status: "" });
	await waitFor(() => port.textsIn(5)[0] === "new");
	await streamer.close();
	assert.equal(port.count("sendMessage"), 1);
});

test("draft: thinking first, then frames; a quiet run re-sends its draft before it expires", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	const settle = async () => {
		for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
	};
	const port = new FakeTelegram();
	const streamer = new PreviewStreamer({
		port,
		chatId: 5,
		replyTo: 1,
		log: silentLogger,
		messageId: undefined,
		draftId: 7,
		onCreated: async () => assert.fail("drafts create no message"),
		intervalMs: 10,
	});
	streamer.push({ text: "", status: "" });
	t.mock.timers.tick(10);
	await settle();
	streamer.push({ text: "", status: "⚙ `read: a.ts`" });
	t.mock.timers.tick(10);
	await settle();
	t.mock.timers.tick(DRAFT_REFRESH_MS);
	await settle();
	t.mock.timers.tick(10);
	await settle();
	await streamer.close();
	assert.deepEqual(
		port.drafts.map((draft) => [draft.draftId, draft.markdown]),
		[
			[7, THINKING],
			[7, "⚙ `read: a.ts`"],
			[7, "⚙ `read: a.ts`"],
		],
	);
	assert.equal(port.count("sendMessage"), 0);
});
