import assert from "node:assert/strict";
import { test } from "node:test";
import { linePatch } from "../../src/agent/tools/write-diff.ts";
import { DEFAULT_VIEW } from "../../src/channel/docs.ts";
import {
	changesFold,
	composeAnswer,
	countPatch,
	diffFor,
	draftStatus,
	footerLine,
	longAnswer,
	reasoningFold,
	stepLine,
	stepsFold,
} from "../../src/delivery/run-view.ts";
import { emptyTrace, type Step, type Trace } from "../../src/delivery/trace.ts";
import { contextLine, flattenFolds, hasCallbackButtons, markChosen } from "../../src/format/rich.ts";
import { SEND_FILE_TOOL } from "../../src/telegram/send-file.ts";

function step(id: string, name: string, args: Step["args"], status: Step["status"], result?: string, patch?: string): Step {
	return { id, name, args, status, ...(result === undefined ? {} : { result }), ...(patch === undefined ? {} : { patch }) };
}

function traceOf(...items: (Step | string)[]): Trace {
	const trace = emptyTrace();
	for (const item of items)
		trace.items.push(typeof item === "string" ? { kind: "text", text: item } : { kind: "call", step: item });
	return trace;
}

test("draft lines: one line per call with its icon and result, at most six, older calls counted", () => {
	const steps = Array.from({ length: 8 }, (_, i) => step(`c${i}`, "read", { path: `f${i}.ts` }, "ok", `line ${i}\nmore`));
	steps[7] = step("c7", "edit", { path: "f7.ts" }, "running");
	steps[6] = step("c6", "write", { path: "f6.ts" }, "error", "EACCES: permission denied");
	const lines = draftStatus(traceOf(...steps), "Now the tests.", "on").split("\n");
	assert.deepEqual(lines, [
		"+2 earlier",
		"✅ `read: f2.ts` · line 2",
		"✅ `read: f3.ts` · line 3",
		"✅ `read: f4.ts` · line 4",
		"✅ `read: f5.ts` · line 5",
		"❌ `write: f6.ts` · EACCES: permission denied",
		"⚙ `edit: f7.ts`",
		"_Now the tests._",
	]);
	assert.equal(draftStatus(traceOf(...steps), "note", "off"), "", "verbose off shows no lines");
	assert.equal(draftStatus(traceOf(step("a", "read", { path: "x" }, "ok"), "Reading next."), undefined, "on").split("\n")[1], "_Reading next._", "the newest text between calls");
});

test("draft lines: full shows arguments and the longer result; markup in results cannot break the line", () => {
	const s = step("a", "read", { path: "a_b.ts", offset: 2 }, "ok", "*bold* <b>x</b> `code` [link](u)");
	assert.equal(stepLine(s, "full"), '✅ `read {"path":"a_b.ts","offset":2}` · \\*bold\\* \\<b\\>x\\</b\\> \\`code\\` \\[link\\](u)');
	assert.equal(stepLine(s, "on", false), "✅ `read: a_b.ts` · bold bx/b code link(u)", "HTML drops markup");
	assert.equal(stepLine(step("b", "read", { path: "p" }, "pending", "old"), "on"), "⚙ `read: p`", "no result while pending");
});

test("file calls: the bot's own short result instead of the tool's text; errors and other tools keep the text", () => {
	const of = (s: Step, file: Step["file"]) => stepLine({ ...s, ...(file === undefined ? {} : { file }) }, "on");
	const wrote = step("w", "write", { path: "guide.md" }, "ok", "Successfully wrote to guide.md");
	assert.equal(of(wrote, { lines: 149 }), "✅ `write: guide.md` · 149 lines");
	assert.equal(of({ ...wrote, created: { lines: 1 } }, { lines: 1 }), "✅ `write: guide.md` · 1 line");
	const edit = step("e", "edit", { path: "guide.md" }, "ok", "Successfully replaced 5 block(s) in guide.md.");
	assert.equal(of(edit, { blocks: 5 }), "✅ `edit: guide.md` · 5 blocks");
	const patch = "--- guide.md\n+++ guide.md\n@@ -1,2 +1,3 @@\n-a\n+b\n+c\n d\n";
	assert.equal(of({ ...edit, patch }, { blocks: 1 }), "✅ `edit: guide.md` · +2 −1", "the diff's counts win");
	const read = step("r", "read", { path: "guide.md" }, "ok", "# Guide: a home office");
	assert.equal(of(read, { lines: 149, from: 1 }), "✅ `read: guide.md` · 149 lines");
	assert.equal(of(read, { lines: 40, from: 41, total: 300 }), "✅ `read: guide.md` · lines 41-80 of 300");
	assert.equal(of(read, { lines: 2000, from: 1, total: 2100 }), "✅ `read: guide.md` · lines 1-2000 of 2100");
	const failed = step("f", "read", { path: "gone.md" }, "error", "ENOENT: no such file, open 'docs/gone.md'.");
	assert.equal(of(failed, undefined), "❌ `read: gone.md` · ENOENT: no such file, open '`docs/gone.md`'.");
	const other = step("o", "telegram_send_file", { path: "x" }, "error", "Not found: notes.md, see https://a.io/b.md.");
	assert.equal(
		stepLine(other, "on"),
		"❌ `telegram_send_file: x` · Not found: `notes.md`, see https://a.io/b.md.",
		"a file name is code, so it is no link; a URL stays as it is",
	);
	assert.equal(stepLine(other, "on", false), "❌ `telegram_send_file: x` · Not found: `notes.md`, see https://a.io/b.md.");
	assert.match(stepsFold(traceOf({ ...edit, file: { blocks: 5 } }), "full") ?? "", /· 5 blocks\n\n<\/details>$/);
	assert.match(stepsFold(traceOf(other), "full") ?? "", /`\n {2}- Not found: `notes\.md`, see/, "full: the text below");
});

test("steps fold: summary with count and names; calls in a row are one list, text between them a paragraph", () => {
	const trace = traceOf(
		"I look first.",
		step("a", "read", { path: "a.ts" }, "ok", "1 line"),
		step("b", "read", { path: "b.ts" }, "ok", "2 lines"),
		"Now I change it.",
		step("c", "write", { path: "a.ts" }, "ok", "Wrote a.ts"),
	);
	assert.equal(
		stepsFold(trace, "on"),
		"<details><summary>3 steps · read, write</summary>\n\nI look first.\n\n- ✅ `read: a.ts` · 1 line\n- ✅ `read: b.ts` · 2 lines\n\nNow I change it.\n\n- ✅ `write: a.ts` · Wrote `a.ts`\n\n</details>",
	);
	assert.equal(stepsFold(trace, "off"), undefined);
	assert.equal(stepsFold(traceOf("only text"), "on"), undefined, "no fold without calls");
	assert.match(stepsFold(trace, "full") ?? "", /- ✅ `write \{"path":"a.ts"\}`\n {2}- Wrote `a\.ts`/);
	const folded = stepsFold(traceOf(step("a", "read", {}, "ok", "x"), "text with </details> and <tg-button-row>"), "on") ?? "";
	assert.equal(folded.match(/<\/details>/g)?.length, 1, "model text cannot close the fold");
});

const lines = (word: string, n: number) => Array.from({ length: n }, (_, i) => `${word} ${i}`).join("\n");

test("changes fold: one diff per file with counts; a long diff shows 60 lines and gets a Full diff button", () => {
	const small = linePatch("src/a.ts", "one\ntwo\nthree\n", "one\nTWO\nthree\n") ?? "";
	const big = linePatch("lib/big.ts", lines("old", 80), lines("new", 80)) ?? "";
	const trace = traceOf(
		step("a", "edit", { path: "src/a.ts" }, "ok", "ok", small),
		step("b", "write", { path: "lib/big.ts" }, "ok", "ok", big),
		step("c", "write", { path: "x.ts" }, "error", "denied", small),
		step("d", "write", { path: "huge.bin" }, "ok", "ok"),
	);
	const { markdown, row, diffs } = changesFold(trace);
	assert.match(markdown ?? "", /^<details><summary>Changes · 3 files \+81 −81<\/summary>/);
	assert.match(markdown ?? "", /\*\*`src\/a\.ts`\*\* \+1 −1\n```diff\n@@ -1,3 \+1,3 @@\n one\n-two\n\+TWO\n three\n```/);
	assert.match(
		markdown ?? "",
		/\*\*`lib\/big\.ts`\*\* \+80 −80\n```diff\n@@ -1,80 \+1,80 @@\n-old 0\n[^`]*\n-old 58\n```\n_… 101 more lines_/,
		"the hunk header and 59 lines, then the rest counted",
	);
	assert.match(markdown ?? "", /\*\*`huge\.bin`\*\* \+0 −0 · diff not kept/);
	assert.doesNotMatch(markdown ?? "", /x\.ts/, "a failed write changed nothing");
	assert.deepEqual(diffs, [
		{ name: "a.ts.diff", text: small },
		{ name: "big.ts.diff", text: big },
	]);
	assert.equal(row, '<tg-button-row><tg-button type="callback_data" data="ork:diff:1">Full diff</tg-button></tg-button-row>');
	assert.equal(diffFor(diffs, "1")?.text, big);
	assert.deepEqual(diffFor(diffs, "all"), { name: "changes.diff", text: small + big });
	assert.equal(diffFor(diffs, "7"), undefined);
	assert.equal(diffFor(diffs, ""), undefined);
	assert.equal(diffFor(undefined, "0"), undefined, "a diff that is no longer kept");
	assert.deepEqual(countPatch(small), { added: 1, removed: 1, lines: 5 }, "the hunk header counts as a shown line");
	assert.deepEqual(changesFold(traceOf(step("a", "read", { path: "a" }, "ok"))), { diffs: [] });
	const short = changesFold(traceOf(step("a", "edit", { path: "src/a.ts" }, "ok", "ok", small)));
	assert.deepEqual([short.row, short.diffs], [undefined, []], "no long diff, no button, nothing kept");
});

test("Full diff buttons: one per long diff, each in its own row, up to three; more share one button", () => {
	const many = (n: number) =>
		traceOf(
			...Array.from({ length: n }, (_, i) =>
				step(`s${i}`, "edit", { path: `f${i}.ts` }, "ok", "ok", linePatch(`f${i}.ts`, lines("a", 40), lines("b", 40))),
			),
		);
	const three = changesFold(many(3));
	const buttons = [...(three.row ?? "").matchAll(/data="([^"]+)">([^<]+)</g)].map((match) => [match[1], match[2]]);
	assert.deepEqual(buttons, [
		["ork:diff:0", "Full diff · f0.ts"],
		["ork:diff:1", "Full diff · f1.ts"],
		["ork:diff:2", "Full diff · f2.ts"],
	]);
	assert.equal(three.row?.split("\n").length, 3, "each button in its own row");
	const four = changesFold(many(4));
	assert.equal(
		four.row,
		'<tg-button-row><tg-button type="callback_data" data="ork:diff:all">Full diff · 4 files</tg-button></tg-button-row>',
	);
	assert.equal(four.diffs.length, 4);
	assert.equal(diffFor(four.diffs, "all")?.text.match(/^--- /gm)?.length, 4, "one .diff with every file");
});

test("changes fold: a new file is one line with its final line count, also after later changes", () => {
	const created = (id: string, path: string, count: number): Step => ({
		...step(id, "write", { path }, "ok", "Wrote"),
		created: { lines: count },
	});
	const edit = linePatch("notes.md", "a\nb\n", "a\nB\nC\n");
	const trace = traceOf(
		created("a", "notes.md", 102),
		step("b", "edit", { path: "notes.md" }, "ok", "ok", edit),
		created("c", "one.txt", 1),
		created("d", "lost.txt", 3),
		step("e", "edit", { path: "lost.txt" }, "ok", "ok"),
	);
	const { markdown, row, diffs } = changesFold(trace);
	assert.equal(
		markdown,
		"<details><summary>Changes · 3 files +104 −0</summary>\n\n**`notes.md`** · new file, 103 lines\n\n**`one.txt`** · new file, 1 line\n\n**`lost.txt`** · new file\n\n</details>",
	);
	assert.deepEqual([row, diffs], [undefined, []], "no diff and no button for a new file");
});

test("sent files: one line in the steps fold; in the changes fold marked sent, with no Full diff button", () => {
	const big = linePatch("report.md", lines("old", 50), lines("new", 50));
	const send = step("s", SEND_FILE_TOOL, { path: "/work/report.md", caption: "Here" }, "ok", "Sent report.md (0 MB).");
	const trace = traceOf(step("w", "write", { path: "report.md" }, "ok", "ok", big), send);
	assert.equal(stepLine(send, "on"), "📎 `report.md` · sent");
	assert.equal(stepLine(send, "full"), "📎 `report.md` · sent");
	assert.match(stepsFold(trace, "full") ?? "", /\n- 📎 `report\.md` · sent\n\n<\/details>$/);
	const { markdown, row } = changesFold(trace);
	assert.match(markdown ?? "", /\*\*`report\.md`\*\* \+50 −50 · sent\n```diff/);
	assert.equal(row, undefined, "the model sent the file: no button sends it again");
	const failed = step("f", SEND_FILE_TOOL, { path: "x" }, "error", "File not found or not readable: x");
	assert.equal(stepLine(failed, "on"), "❌ `telegram_send_file: x` · File not found or not readable: x");
	const other = traceOf(step("w", "write", { path: "docs/report.md" }, "ok", "ok", big), {
		...send,
		args: { path: "report.md" },
	});
	assert.ok(changesFold(other).row !== undefined, "another file with the same name keeps its button");
});

test("write diff: one hunk with three context lines, new and emptied files, undefined without a change", () => {
	const before = "a\nb\nc\nd\ne\nf\ng\nh\n";
	assert.equal(linePatch("f.txt", before, "a\nb\nc\nd\nE\nf\ng\nh\n"), "--- f.txt\n+++ f.txt\n@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E\n f\n g\n h\n");
	assert.equal(linePatch("n.txt", "", "x\ny\n"), "--- n.txt\n+++ n.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n");
	assert.equal(linePatch("n.txt", "x\n", ""), "--- n.txt\n+++ n.txt\n@@ -1,1 +0,0 @@\n-x\n");
	assert.equal(linePatch("same.txt", "x\n", "x\n"), undefined);
});

test("footer: model, effort, preset, context share and time; unknown parts and effort off are left out", () => {
	const trace: Trace = { ...emptyTrace(), model: "deepseek-v4-pro", contextTokens: 2560, startedAt: 1000, endedAt: 66_000 };
	assert.equal(footerLine(trace, 128_000), "_deepseek-v4-pro · 2% · 1m 5s_");
	assert.equal(footerLine({ ...trace, endedAt: 3400 }, undefined), "_deepseek-v4-pro · 2s_");
	assert.equal(footerLine(emptyTrace(), 1000), undefined);
	assert.equal(footerLine({ ...trace, effort: "high", preset: "smart" }, undefined), "_deepseek-v4-pro · high (smart) · 1m 5s_");
	assert.equal(footerLine({ ...trace, effort: "off", preset: "my_fast" }, undefined), "_deepseek-v4-pro (my\\_fast) · 1m 5s_");
});

test("reasoning fold: hidden by default; shown above the answer with /reasoning show", () => {
	const trace: Trace = { ...emptyTrace(), reasoning: ["First I think.", "Then <details>more</details>."] };
	assert.equal(reasoningFold(trace), "<details><summary>Reasoning</summary>\n\nFirst I think.\n\nThen more.\n\n</details>");
	const hidden = composeAnswer({ answer: "Done.", trace, view: DEFAULT_VIEW, limit: undefined, rich: true });
	assert.equal(hidden.markdown, "Done.");
	const shown = composeAnswer({ answer: "Done.", trace, view: { ...DEFAULT_VIEW, reasoning: true }, limit: undefined, rich: true });
	assert.match(shown.markdown, /^<details><summary>Reasoning<\/summary>[\s\S]*<\/details>\n\nDone\.$/);
});

test("final answer: answer, steps, changes and footer in this order; HTML gets the answer only", () => {
	const patch = linePatch("a.ts", "x\n", "y\n");
	const trace: Trace = {
		...traceOf(step("a", "write", { path: "a.ts" }, "ok", "Wrote", patch)),
		model: "m1",
		contextTokens: 50,
		startedAt: 0,
		endedAt: 4000,
	};
	const rich = composeAnswer({ answer: "All done.", trace, view: DEFAULT_VIEW, limit: 1000, rich: true });
	const parts = rich.markdown.split("\n\n");
	assert.equal(parts[0], "All done.");
	assert.match(rich.markdown, /All done\.\n\n<details><summary>1 step · write<\/summary>[\s\S]*<\/details>\n\n<details><summary>Changes · 1 file \+1 −1<\/summary>[\s\S]*<\/details>\n\n_m1 · 5% · 4s_$/);
	assert.deepEqual(composeAnswer({ answer: "All done.", trace, view: DEFAULT_VIEW, limit: 1000, rich: false }), {
		markdown: "All done.",
		documents: [],
		diffs: [],
	});
	const quiet = composeAnswer({ answer: "All done.", trace, view: { ...DEFAULT_VIEW, verbose: "off" }, limit: 1000, rich: true });
	assert.doesNotMatch(quiet.markdown, /<details>/, "verbose off has no steps or changes fold");
	assert.deepEqual(quiet.documents, []);
	const empty = composeAnswer({ answer: undefined, trace: emptyTrace(), view: DEFAULT_VIEW, limit: undefined, rich: true });
	assert.equal(empty.markdown, "", "an empty answer, no steps and no changes leave nothing");
	const big = linePatch("b.ts", lines("x", 70), lines("y", 70));
	const long = { ...trace, items: traceOf(step("b", "edit", { path: "b.ts" }, "ok", "ok", big)).items };
	const withRow = composeAnswer({ answer: "Done.", trace: long, view: DEFAULT_VIEW, limit: 1000, rich: true });
	assert.match(withRow.markdown, /<\/details>\n\n<tg-button-row><tg-button [^>]*data="ork:diff:0">Full diff<\/tg-button><\/tg-button-row>\n\n_m1 · /);
	assert.deepEqual(withRow.diffs, [{ name: "b.ts.diff", text: big }]);
	assert.deepEqual(withRow.documents, [], "no .diff document goes out by itself");
});

test("long answer: the start cut at a paragraph outside code, a note and the buttons; the whole text as answer.md", () => {
	const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"word ".repeat(20)}`.trim());
	const buttons = '<tg-button-row><tg-button type="callback_data" data="yes">Yes</tg-button></tg-button-row>';
	const answer = `${paragraphs.join("\n\n")}\n\n${buttons}`;
	const long = longAnswer(answer);
	assert.ok(answer.length > 4000);
	assert.equal(long.document?.name, "answer.md");
	assert.equal(long.document?.text, answer);
	const [start, ...rest] = long.text.split("\n\n_… the full answer is in answer.md_\n\n");
	assert.ok((start?.length ?? 0) <= 1500 && start?.endsWith("word"), "cut at the end of a paragraph");
	assert.deepEqual(rest, [buttons]);
	const code = `\`\`\`\n${"x\n".repeat(3000)}\`\`\`\n\nafter`;
	assert.match(longAnswer(code).text, /^```\n(x\n)+```\n\n_… the full/, "an open fence is closed");
	assert.deepEqual(longAnswer("short"), { text: "short" });
});

test("folds: flattened for HTML; left out of the context line with the footer", () => {
	const markdown = "Answer.\n\n<details><summary>2 steps · read</summary>\n\n- a\n\n</details>\n\n_m1 · 5% · 4s_";
	assert.equal(flattenFolds(markdown), "Answer.\n\n2 steps · read\n\n- a\n\n\n\n_m1 · 5% · 4s_");
	assert.equal(contextLine(markdown, 100), "Answer.");
});

test("own buttons: Full diff is not a model choice; it is never disabled and stays out of the context line", () => {
	const own = '<tg-button-row><tg-button type="callback_data" data="ork:diff:0">Full diff</tg-button></tg-button-row>';
	const pick = '<tg-button type="callback_data" data="a">A</tg-button>';
	assert.equal(hasCallbackButtons(`Done.\n\n${own}`), false, "no model buttons to keep");
	assert.equal(hasCallbackButtons(`Pick ${pick}\n\n${own}`), true);
	const marked = markChosen(`Pick ${pick}\n\n${own}\n\n_m1 · 4s_`, "a") ?? "";
	assert.ok(marked.includes(own), "a choice outside a row leaves the Full diff button as it is");
	assert.equal(contextLine(`Pick ${pick}\n\n${own}\n\n_m1 · 4s_`, 100), "Pick [A]");
});
