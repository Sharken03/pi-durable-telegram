import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { CHAT, newFaux, startTestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastToolResult, lastUserText, observe, textOf, toolCall } from "../helpers/faux-steps.ts";
import { documentUpdate, textUpdate } from "../helpers/updates.ts";
import { docx, makeZip, para } from "../helpers/zip.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Seen = { isError: boolean; text: string };

function inspect(messages: readonly Message[]): Seen {
	const result = lastToolResult(messages);
	return { isError: result?.isError === true, text: textOf(result) };
}

test("office: read shows docx as Markdown with offset; old and other binary files get a clear error", async () => {
	const faux = newFaux();
	const seen: Seen[] = [];
	const step = (next: ReturnType<typeof toolCall>) => observe((messages) => seen.push(inspect(messages)), next);
	faux.setResponses([
		toolCall("read", { path: "notes.docx" }),
		step(toolCall("read", { path: "notes.docx", offset: 3, limit: 1 })),
		step(toolCall("read", { path: "old.doc" })),
		step(toolCall("read", { path: "bundle.zip" })),
		step(fauxAssistantMessage("read all")),
	]);
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir, faux, port });
	cleanups.push(() => t.close());
	const work = join(dir, "work");
	await writeFile(join(work, "notes.docx"), docx(para("Plan", "Heading1") + para("Buy tea") + para("Call Ann")));
	await writeFile(join(work, "old.doc"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
	await writeFile(join(work, "bundle.zip"), makeZip({ "readme.txt": "hi" }));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "read"));
	await waitFor(() => port.textsIn(CHAT).includes("read all"));
	assert.equal(seen[0]?.isError, false);
	assert.match(seen[0]?.text ?? "", /^Word document \/.*notes\.docx\. Shown as Markdown, 3 lines\.\n\n# Plan\nBuy tea\nCall Ann$/);
	assert.match(seen[1]?.text ?? "", /\n\nCall Ann$/);
	assert.equal(seen[2]?.isError, true);
	assert.match(seen[2]?.text ?? "", /old\.doc: it is an old binary Office file \(doc, xls, ppt\) or a password-protected/);
	assert.equal(seen[3]?.isError, true);
	assert.match(seen[3]?.text ?? "", /bundle\.zip: it is a ZIP archive, not a Word, Excel or PowerPoint file\./);
});

test("office: incoming PDF and Office documents are announced for the read tool; other ZIP files are not", async () => {
	const faux = newFaux();
	const notes: string[] = [];
	const note = (answer: string) =>
		observe((messages) => notes.push(lastUserText(messages)), fauxAssistantMessage(answer));
	faux.setResponses([note("one"), note("two"), note("three")]);
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir, faux, port });
	cleanups.push(() => t.close());
	port.files.set("d1", docx(para("Hi")));
	port.files.set("p1", Buffer.from("%PDF-1.7\n"));
	port.files.set("z1", makeZip({ "a.txt": "x" }));
	await t.agent.channel.handleUpdate(documentUpdate(CHAT, 2, "d1", "Plan.docx", 300));
	await waitFor(() => port.textsIn(CHAT).includes("one"));
	await t.agent.channel.handleUpdate(documentUpdate(CHAT, 3, "p1", "scan.pdf", 9));
	await waitFor(() => port.textsIn(CHAT).includes("two"));
	await t.agent.channel.handleUpdate(documentUpdate(CHAT, 4, "z1", "files.zip", 100));
	await waitFor(() => port.textsIn(CHAT).includes("three"));
	assert.match(notes[0] ?? "", /Plan\.docx.*\nRead it with the read tool\./);
	assert.match(notes[1] ?? "", /scan\.pdf.*\nRead it with the read tool\./);
	assert.doesNotMatch(notes[2] ?? "", /read tool/);
});
