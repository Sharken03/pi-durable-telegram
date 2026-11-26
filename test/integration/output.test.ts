import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type FauxProviderHandle, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { DIFF_GONE_TEXT } from "../../src/channel/tap.ts";
import { linePatch } from "../../src/agent/tools/write-diff.ts";
import { RETRY_DATA, STOP_DATA } from "../../src/delivery/send-phase.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { gate, gated, lastUserText, observe, untilAborted } from "../helpers/faux-steps.ts";
import { callbackUpdate, textUpdate } from "../helpers/updates.ts";

const RICH = { TELEGRAM_RICH: "auto" };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
	faux: FauxProviderHandle,
	config: Record<string, string> = RICH,
	dir?: string,
): Promise<{ t: TestAgent; port: FakeTelegram; dir: string }> {
	let root = dir;
	if (root === undefined) {
		const temp = await tempDir();
		cleanups.push(temp.cleanup);
		root = temp.dir;
	}
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir: root, faux, port, config });
	cleanups.push(() => t.close());
	return { t, port, dir: root };
}

function replyTo(port: FakeTelegram, messageId: number) {
	return port.created(CHAT).find((m) => m.replyTo === messageId);
}

const writeCall = (text: string, path: string, content: string) =>
	fauxAssistantMessage([fauxText(text), fauxToolCall("write", { path, content })], { stopReason: "toolUse" });

test("T-draft-lines: the draft shows each call and the text between calls; the answer folds steps and changes", async () => {
	const faux = newFaux();
	const release = gate();
	faux.setResponses([
		writeCall("I write the file.", "notes.txt", "one\ntwo\n"),
		gated(release.promise, () => fauxAssistantMessage("Done.")),
	]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "write notes"));
	const draft = await waitFor(() => port.drafts.find((d) => d.markdown.includes("✅ `write: notes.txt`")), {
		what: "draft with the call line",
	});
	assert.match(draft.markdown, /^✅ `write: notes\.txt` · 2 lines$/m, "the bot's own short result");
	release.open();
	const answer = await waitFor(() => replyTo(port, 1), { what: "answer" });
	assert.match(answer.text, /^Done\.\n\n<details><summary>1 step · write<\/summary>\n\nI write the file\.\n\n- ✅/);
	assert.match(
		answer.text,
		/<details><summary>Changes · 1 file \+2 −0<\/summary>\n\n\*\*`notes\.txt`\*\* · new file, 2 lines\n\n<\/details>/,
		"a new file is one line, with no diff",
	);
	assert.match(answer.text, /\n\n_faux-1 · \d+% · \d+s_$/, "the footer ends the answer");
	assert.equal(answer.silent, undefined, "an answer rings");
	assert.ok(
		port.drafts.some((d) => d.markdown.includes("_I write the file._")),
		"the text between calls is one italic line",
	);
});

test("T-verbose: /verbose off drops call lines and folds and is kept across a restart; full shows arguments", async () => {
	const faux = newFaux();
	faux.setResponses([
		writeCall("", "a.txt", "x\n"),
		fauxAssistantMessage("Quiet."),
		writeCall("", "b.txt", "y\n"),
		fauxAssistantMessage("Loud."),
	]);
	const first = await setup(faux);
	await first.t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/verbose off"));
	assert.equal((await waitFor(() => replyTo(first.port, 1))).text, "Verbose: off.");
	assert.equal(replyTo(first.port, 1)?.silent, true, "a command reply is silent");
	await first.t.close();
	cleanups.pop();

	const { t, port } = await setup(faux, RICH, first.dir);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/verbose"));
	assert.match((await waitFor(() => replyTo(port, 2))).text, /^Verbose: off\./);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "go"));
	const quiet = await waitFor(() => replyTo(port, 3), { what: "quiet answer" });
	assert.doesNotMatch(quiet.text, /<details>/, "no steps or changes fold");
	assert.ok(port.drafts.every((d) => !d.markdown.includes("write")), "no call lines in the draft");

	await t.agent.channel.handleUpdate(textUpdate(CHAT, 4, "/verbose full"));
	await waitFor(() => replyTo(port, 4));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 5, "again"));
	const loud = await waitFor(() => replyTo(port, 5), { what: "full answer" });
	assert.match(loud.text, /- ✅ `write \{"path":"b\.txt","content":"y\\n"\}` · 1 line\n\n<\/details>/);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 6, "/verbose loud"));
	assert.match((await waitFor(() => replyTo(port, 6))).text, /^Unknown level "loud"\. Use \/verbose off\|on\|full\./);
});

test("T-file-steps: read, write and edit show the bot's short result; an error keeps the tool's text", async () => {
	const faux = newFaux();
	const call = (name: string, args: Record<string, unknown>) =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	faux.setResponses([
		call("read", { path: "guide.md" }),
		call("edit", { path: "guide.md", edits: [{ oldText: "two", newText: "TWO\nmore" }] }),
		call("read", { path: "big.txt", offset: 41, limit: 40 }),
		call("read", { path: "big.txt" }),
		call("read", { path: "gone.md" }),
		fauxAssistantMessage("Done."),
	]);
	const { t, port, dir } = await setup(faux);
	await writeFile(join(dir, "work", "guide.md"), "one\ntwo\nthree\n");
	await writeFile(join(dir, "work", "big.txt"), numbered("line", 2100));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "look"));
	const answer = await waitFor(() => replyTo(port, 1), { what: "answer" });
	const steps = answer.text.split("\n").filter((line) => line.startsWith("- "));
	// The file's line count is the read tool's own: it counts the empty text after the last newline as a line.
	assert.deepEqual(steps.slice(0, 4), [
		"- ✅ `read: guide.md` · 3 lines",
		"- ✅ `edit: guide.md` · +2 −1",
		"- ✅ `read: big.txt` · lines 41-80 of 2101",
		"- ✅ `read: big.txt` · lines 1-2000 of 2101",
	]);
	assert.match(steps[4] ?? "", /^- ❌ `read: gone\.md` · ENOENT: no such file/, "the error's text, not its harness tag");
});

test("T-reasoning: hidden by default; /reasoning show puts a fold above the answer", async () => {
	const faux = newFaux();
	const thought = () => fauxAssistantMessage([fauxThinking("I weigh the options."), fauxText("Answer.")]);
	faux.setResponses([thought(), thought()]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "think"));
	assert.doesNotMatch((await waitFor(() => replyTo(port, 1))).text, /Reasoning/);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/reasoning show"));
	assert.equal((await waitFor(() => replyTo(port, 2))).text, "Reasoning: show.");
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "think again"));
	const shown = await waitFor(() => replyTo(port, 3));
	assert.match(shown.text, /^<details><summary>Reasoning<\/summary>\n\nI weigh the options\.\n\n<\/details>\n\nAnswer\./);
});

test("T-answer-md: a long answer sends its start and the whole text as answer.md, without a second model call", async () => {
	const paragraphs = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: ${"text ".repeat(15)}`.trim());
	const long = paragraphs.join("\n\n");
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage(long)]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "write a lot"));
	const document = await waitFor(() => port.documentsIn(CHAT)[0], { what: "answer.md" });
	const start = replyTo(port, 1);
	assert.ok(start !== undefined);
	assert.match(start.text, /^Paragraph 0: [\s\S]*\n\n_… the full answer is in answer\.md_\n\n_faux-1 · /);
	assert.ok(start.text.length < 2000);
	assert.equal(document.fileName, "answer.md");
	assert.equal(document.content, long);
	assert.equal(document.silent, true, "the document after the answer is silent");
	assert.equal(faux.state.callCount, 1);
});

test("T-error-retry: an error is one ❌ line with Retry and Stop; Retry runs the request again, once", async () => {
	const faux = newFaux();
	const seen: string[] = [];
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid request: bad tool schema" }),
		observe((messages) => void seen.push(lastUserText(messages)), fauxAssistantMessage("recovered")),
	]);
	const { t, port } = await setup(faux, {});
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 7, "do the thing"));
	const error = await waitFor(() => replyTo(port, 7), { what: "error" });
	assert.match(error.text, /^❌ /);
	assert.equal(error.text.split("\n").length, 1);
	assert.deepEqual(error.buttons, [
		[
			{ text: "Retry", data: RETRY_DATA },
			{ text: "Stop", data: STOP_DATA },
		],
	]);
	assert.equal(error.silent, undefined, "an error rings");
	await t.agent.channel.handleUpdate(callbackUpdate(CHAT, error.id, RETRY_DATA, { queryId: "cq-retry" }));
	await waitFor(() => port.textsIn(CHAT).includes("recovered"), { what: "retried answer" });
	assert.deepEqual(seen, ["do the thing"], "the same request, with a new time stamp");
	assert.equal(port.created(CHAT).find((m) => m.text === "recovered")?.replyTo, 7, "it answers the user's message");
	await waitFor(() => port.messages.get(error.id)?.buttons === undefined, { what: "buttons removed" });
	assert.ok(port.answeredQueries.includes("cq-retry"));
	await t.agent.channel.handleUpdate(callbackUpdate(CHAT, error.id, RETRY_DATA, { queryId: "cq-again" }));
	await waitFor(() => t.logs.some((line) => line.includes("retry_unknown")), { what: "second retry ignored" });
	assert.equal(faux.state.callCount, 2, "a second tap does not run the request again");
});

test("T-error-stop: Stop under an error stops the run that is going on", async () => {
	const faux = newFaux();
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid request: bad tool schema" }),
		untilAborted,
	]);
	const { t, port } = await setup(faux, {});
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "first"));
	const error = await waitFor(() => replyTo(port, 1), { what: "error" });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "second"));
	await waitFor(() => faux.state.callCount === 2, { what: "second run" });
	await t.agent.channel.handleUpdate(callbackUpdate(CHAT, error.id, STOP_DATA, { queryId: "cq-stop" }));
	const stopped = await waitFor(() => replyTo(port, error.id), { what: "stop reply" });
	assert.equal(stopped.text, "Stopped.");
	await waitFor(() => port.messages.get(error.id)?.buttons === undefined, { what: "buttons removed" });
	assert.equal(faux.state.callCount, 2, "the tap never reached the model");
});

test("T-sound: the HTML preview is sent without a sound", async () => {
	const faux = newFaux({ tokensPerSecond: 150 });
	faux.setResponses([fauxAssistantMessage(`Answer ${"word ".repeat(150)}`.trim())]);
	const { t, port } = await setup(faux, {});
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "stream"));
	await waitFor(() => port.calls.some((call) => call.method === "editMessageText"), { what: "preview" });
	const first = port.calls.find((call) => call.method === "sendMessage");
	assert.equal(first?.options?.silent, true, "the preview message is sent without a sound");
	await waitFor(() => t.logs.some((line) => line.includes("info delivered")), { what: "delivered" });
});

const numbered = (word: string, n: number) => Array.from({ length: n }, (_, i) => `${word} ${i}\n`).join("");

test("T-full-diff: a long diff shows 60 lines and a Full diff button; a tap sends the .diff, also after a restart", async () => {
	const faux = newFaux();
	faux.setResponses([writeCall("", "big.txt", numbered("new", 80)), fauxAssistantMessage("Rewritten.")]);
	const first = await setup(faux);
	await writeFile(join(first.dir, "work", "big.txt"), numbered("old", 80));
	await first.t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "rewrite big.txt"));
	const answer = await waitFor(() => replyTo(first.port, 1), { what: "answer" });
	assert.match(answer.text, /\*\*`big\.txt`\*\* \+80 −80\n```diff\n@@ -1,80 \+1,80 @@\n-old 0\n/);
	assert.match(answer.text, /```\n_… 101 more lines_\n\n<\/details>/);
	assert.match(answer.text, /<tg-button type="callback_data" data="ork:diff:0">Full diff<\/tg-button>/);
	await waitFor(() => first.t.logs.some((line) => line.includes("info delivered")), { what: "delivered" });
	assert.deepEqual(first.port.documentsIn(CHAT), [], "no .diff file before a tap");
	await first.t.close();
	cleanups.pop();

	const { t, port } = await setup(faux, RICH, first.dir);
	await t.agent.channel.handleUpdate(callbackUpdate(CHAT, answer.id, "ork:diff:0", { queryId: "cq-diff" }));
	const document = await waitFor(() => port.documentsIn(CHAT)[0], { what: ".diff document" });
	assert.equal(document.fileName, "big.txt.diff");
	assert.equal(document.content, linePatch("big.txt", numbered("old", 80), numbered("new", 80)));
	assert.equal(document.replyTo, answer.id);
	assert.equal(document.silent, true);
	assert.ok(port.answeredQueries.includes("cq-diff"));
	assert.equal(faux.state.callCount, 2, "the tap never reached the model");

	await t.agent.channel.handleUpdate(callbackUpdate(CHAT, 4242, "ork:diff:0", { queryId: "cq-old" }));
	const gone = await waitFor(() => replyTo(port, 4242), { what: "gone note" });
	assert.equal(gone.text, DIFF_GONE_TEXT);
	assert.equal(gone.silent, true);
	assert.equal(port.documentsIn(CHAT).length, 1);
});

test("T-sent-file: a file the model sent is one line in the steps fold and is not sent again", async () => {
	const faux = newFaux();
	faux.setResponses([
		writeCall("", "report.txt", numbered("line", 70)),
		fauxAssistantMessage([fauxToolCall("telegram_send_file", { path: "report.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Sent it."),
	]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "send me a report"));
	const answer = await waitFor(() => replyTo(port, 1), { what: "answer" });
	assert.match(answer.text, /\n- 📎 `report\.txt` · sent\n\n<\/details>/);
	assert.match(answer.text, /\*\*`report\.txt`\*\* · new file, 70 lines · sent/);
	assert.doesNotMatch(answer.text, /ork:diff/);
	await waitFor(() => t.logs.some((line) => line.includes("info delivered")), { what: "delivered" });
	const documents = port.created(CHAT).filter((m) => m.kind === "document");
	assert.deepEqual(
		documents.map((m) => m.path?.endsWith("report.txt")),
		[true],
		"only the model's own send",
	);
});

