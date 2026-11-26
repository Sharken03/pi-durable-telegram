import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type FauxResponseFactory, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { UsageDoc } from "@earendil-works/pi-durable";
import { ChatMap } from "../../src/channel/docs.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastToolResult, observe, textOf, toolCall } from "../helpers/faux-steps.ts";
import { pngBytes } from "../helpers/images.ts";
import { fakePrograms } from "../helpers/programs.ts";
import { textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A text-only main model and an image model on the same faux provider; they share one response queue. */
function twoModels() {
	return newFaux({
		models: [
			{ id: "faux-1", input: ["text"] },
			{ id: "faux-eye", input: ["text", "image"] },
		],
	});
}

type Setup = { t: TestAgent; port: FakeTelegram; work: string };

async function setup(faux: ReturnType<typeof twoModels>, visionModel: string, bin?: string): Promise<Setup> {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	const t = await startTestAgent({
		dir,
		faux,
		port,
		config: { PI_VISION_MODEL: visionModel },
		deps: bin === undefined ? {} : { programPath: bin },
	});
	cleanups.push(cleanup, () => t.close());
	const work = join(dir, "work");
	await mkdir(join(work, "inbox"), { recursive: true });
	return { t, port, work };
}

type Seen = { isError: boolean; text: string; parts: string[] };

function inspect(messages: readonly Message[]): Seen {
	const result = lastToolResult(messages);
	const parts = (result?.content ?? []).map((part) => (part.type === "image" ? "image" : part.text));
	return { isError: result?.isError === true, text: textOf(result), parts };
}

type Asked = { model: string; prompt: string; mime: string | undefined };

/** The vision model's turn: records what it was asked and answers with `answer`. */
function vision(asked: Asked[], answer: string): FauxResponseFactory {
	return (context, _options, _state, model) => {
		const message = context.messages[0];
		const content = message?.role === "user" && Array.isArray(message.content) ? message.content : [];
		const prompt = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		const image = content.find((part) => part.type === "image");
		asked.push({ model: model.id, prompt, mime: image?.type === "image" ? image.mimeType : undefined });
		return fauxAssistantMessage(answer);
	};
}

async function toolSpend(t: TestAgent) {
	const id = await waitFor(async () => (await t.agent.harness.snapshot(ChatMap, BG))?.chats[String(CHAT)]);
	return (await t.agent.harness.snapshot(UsageDoc, id as never, BG))?.tools.read;
}

test("vision: a text-only model gets an image as a description from the vision model, and the spend counts", async () => {
	const faux = twoModels();
	const asked: Asked[] = [];
	const seen: Seen[] = [];
	faux.setResponses([
		toolCall("read", { path: "inbox/pic.png" }),
		vision(asked, "A black square. Text: HELLO."),
		observe((messages) => seen.push(inspect(messages)), fauxAssistantMessage("a square")),
	]);
	const { t, port, work } = await setup(faux, "faux/faux-eye");
	await writeFile(join(work, "inbox", "pic.png"), pngBytes(64, 48));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "look"));
	await waitFor(() => port.textsIn(CHAT).includes("a square"));
	assert.equal(asked.length, 1);
	assert.equal(asked[0]?.model, "faux-eye");
	assert.equal(asked[0]?.mime, "image/png");
	assert.match(asked[0]?.prompt ?? "", /^Describe this image for an assistant that cannot see it/);
	assert.equal(seen[0]?.isError, false);
	assert.match(
		seen[0]?.text ?? "",
		/pic\.png \(64x48, 0\.0 MB\)\. This model cannot view images; the vision model faux\/faux-eye describes it:\n\nA black square\. Text: HELLO\.$/,
	);
	assert.equal(seen[0]?.parts.length, 1, "no image bytes and no 'cannot view' note");
	const spend = await toolSpend(t);
	assert.ok((spend?.output ?? 0) > 0, "the vision model's tokens count as read's usage");
});

test("vision: an unusable vision model leaves the note; off keeps the old behaviour", async () => {
	const faux = twoModels();
	const seen: Seen[] = [];
	faux.setResponses([
		toolCall("read", { path: "inbox/pic.png" }),
		observe((messages) => seen.push(inspect(messages)), toolCall("read", { path: "inbox/pic.png" })),
		observe((messages) => seen.push(inspect(messages)), fauxAssistantMessage("no luck")),
	]);
	const { t, port, work } = await setup(faux, "faux/faux-1");
	await writeFile(join(work, "inbox", "pic.png"), pngBytes(8, 8));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "look"));
	await waitFor(() => port.textsIn(CHAT).includes("no luck"));
	const why = /the vision model faux\/faux-1 could not describe it: it does not take images\./;
	assert.match(seen[0]?.text ?? "", why);
	assert.match(seen[1]?.text ?? "", why, "a failed lookup is tried again");
	assert.deepEqual(seen[1]?.parts.slice(-1), ["[this model cannot view images]"]);

	const plain = twoModels();
	const plainSeen: Seen[] = [];
	plain.setResponses([
		toolCall("read", { path: "inbox/pic.png" }),
		observe((messages) => plainSeen.push(inspect(messages)), fauxAssistantMessage("plain")),
	]);
	const off = await setup(plain, "off");
	await writeFile(join(off.work, "inbox", "pic.png"), pngBytes(8, 8));
	await off.t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "look"));
	await waitFor(() => off.port.textsIn(CHAT).includes("plain"));
	assert.match(plainSeen[0]?.text ?? "", /is attached for viewing\./);
	assert.deepEqual(plainSeen[0]?.parts.slice(-1), ["[this model cannot view images]"]);
});

test("vision: a scanned PDF page is transcribed by the vision model for a text-only model", async () => {
	const { dir, cleanup } = await tempDir("pdt-bin-");
	cleanups.push(cleanup);
	await writeFile(join(dir, "page.png"), pngBytes(40, 56));
	const bin = await fakePrograms(join(dir, "bin"), {
		pdfinfo: "printf 'Pages:          3\\nPage size:      595 x 842 pts (A4)\\n'",
		pdftotext: "printf 'Text of page one, long enough to count.\\f \\fText of page three, long enough to count.\\f'",
		pdftoppm: `for last; do :; done\ncp ${join(dir, "page.png")} "$last.png"`,
	});
	const faux = twoModels();
	const asked: Asked[] = [];
	const seen: Seen[] = [];
	faux.setResponses([
		toolCall("read", { path: "scan.pdf" }),
		vision(asked, "Invoice 42\n| Item | Price |\n|---|---|\n| Tea | 3 |"),
		observe((messages) => seen.push(inspect(messages)), fauxAssistantMessage("invoice")),
	]);
	const { t, port, work } = await setup(faux, "faux/faux-eye", bin);
	await writeFile(join(work, "scan.pdf"), "%PDF-1.7\n");
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "read"));
	await waitFor(() => port.textsIn(CHAT).includes("invoice"));
	assert.equal(asked.length, 1);
	assert.match(asked[0]?.prompt ?? "", /^This is a document page without a text layer/);
	const text = seen[0]?.text ?? "";
	assert.match(text, /--- Page 2: no text layer \(a scan or a picture\); rendered for a vision model, which reads it below ---/);
	assert.match(text, /\[Read by the vision model faux\/faux-eye:\]\nInvoice 42\n\| Item \| Price \|/);
	assert.match(text, /--- Page 3 ---\nText of page three/);
	assert.equal(seen[0]?.parts.length, 1, "the rendered page is not attached and gets no note");
	assert.ok(((await toolSpend(t))?.output ?? 0) > 0);
});
