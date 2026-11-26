import assert from "node:assert/strict";
import { test } from "node:test";
import { linePatch } from "../../src/agent/tools/write-diff.ts";
import { DEFAULT_VIEW } from "../../src/channel/docs.ts";
import {
	changesFold,
	composeAnswer,
	countPatch,
	draftStatus,
	footerLine,
	longAnswer,
	reasoningFold,
	stepLine,
	stepsFold,
} from "../../src/delivery/run-view.ts";
import { emptyTrace, type Step, type Trace } from "../../src/delivery/trace.ts";
import { contextLine, flattenFolds } from "../../src/format/rich.ts";

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
		"<details><summary>▸ 3 steps · read, write</summary>\n\nI look first.\n\n- ✅ `read: a.ts` · 1 line\n- ✅ `read: b.ts` · 2 lines\n\nNow I change it.\n\n- ✅ `write: a.ts` · Wrote a.ts\n\n</details>",
	);
	assert.equal(stepsFold(trace, "off"), undefined);
	assert.equal(stepsFold(traceOf("only text"), "on"), undefined, "no fold without calls");
	assert.match(stepsFold(trace, "full") ?? "", /- ✅ `write \{"path":"a.ts"\}`\n {2}- Wrote a\.ts/);
	const folded = stepsFold(traceOf(step("a", "read", {}, "ok", "x"), "text with </details> and <tg-button-row>"), "on") ?? "";
	assert.equal(folded.match(/<\/details>/g)?.length, 1, "model text cannot close the fold");
});

test("changes fold: one diff block per file with counts; a long diff goes out as a .diff document", () => {
	const small = linePatch("src/a.ts", "one\ntwo\nthree\n", "one\nTWO\nthree\n") ?? "";
	const bigBefore = Array.from({ length: 80 }, (_, i) => `old ${i}`).join("\n");
	const bigAfter = Array.from({ length: 80 }, (_, i) => `new ${i}`).join("\n");
	const big = linePatch("lib/big.ts", bigBefore, bigAfter) ?? "";
	const trace = traceOf(
		step("a", "edit", { path: "src/a.ts" }, "ok", "ok", small),
		step("b", "write", { path: "lib/big.ts" }, "ok", "ok", big),
		step("c", "write", { path: "x.ts" }, "error", "denied", small),
		step("d", "write", { path: "huge.bin" }, "ok", "ok"),
	);
	const { markdown, documents } = changesFold(trace);
	assert.match(markdown ?? "", /^<details><summary>▸ Changes · 3 files \+81 −81<\/summary>/);
	assert.match(markdown ?? "", /\*\*`src\/a\.ts`\*\* \+1 −1\n```diff\n@@ -1,3 \+1,3 @@\n one\n-two\n\+TWO\n three\n```/);
	assert.match(markdown ?? "", /\*\*`lib\/big\.ts`\*\* \+80 −80 · in `big\.ts\.diff`/);
	assert.match(markdown ?? "", /\*\*`huge\.bin`\*\* \+0 −0 · diff not kept/);
	assert.doesNotMatch(markdown ?? "", /x\.ts/, "a failed write changed nothing");
	assert.deepEqual(documents, [{ name: "big.ts.diff", text: big }]);
	assert.deepEqual(countPatch(small), { added: 1, removed: 1, lines: 5 }, "the hunk header counts as a shown line");
	assert.deepEqual(changesFold(traceOf(step("a", "read", { path: "a" }, "ok"))), { markdown: undefined, documents: [] });
});

test("write diff: one hunk with three context lines, new and emptied files, undefined without a change", () => {
	const before = "a\nb\nc\nd\ne\nf\ng\nh\n";
	assert.equal(linePatch("f.txt", before, "a\nb\nc\nd\nE\nf\ng\nh\n"), "--- f.txt\n+++ f.txt\n@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E\n f\n g\n h\n");
	assert.equal(linePatch("n.txt", "", "x\ny\n"), "--- n.txt\n+++ n.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n");
	assert.equal(linePatch("n.txt", "x\n", ""), "--- n.txt\n+++ n.txt\n@@ -1,1 +0,0 @@\n-x\n");
	assert.equal(linePatch("same.txt", "x\n", "x\n"), undefined);
});

test("footer: model, context share and time; unknown parts are left out", () => {
	const trace: Trace = { ...emptyTrace(), model: "deepseek-v4-pro", contextTokens: 2560, startedAt: 1000, endedAt: 66_000 };
	assert.equal(footerLine(trace, 128_000), "_deepseek-v4-pro · 2% · 1m 5s_");
	assert.equal(footerLine({ ...trace, endedAt: 3400 }, undefined), "_deepseek-v4-pro · 2s_");
	assert.equal(footerLine(emptyTrace(), 1000), undefined);
});

test("reasoning fold: hidden by default; shown above the answer with /reasoning show", () => {
	const trace: Trace = { ...emptyTrace(), reasoning: ["First I think.", "Then <details>more</details>."] };
	assert.equal(reasoningFold(trace), "<details><summary>▸ Reasoning</summary>\n\nFirst I think.\n\nThen more.\n\n</details>");
	const hidden = composeAnswer({ answer: "Done.", trace, view: DEFAULT_VIEW, limit: undefined, rich: true });
	assert.equal(hidden.markdown, "Done.");
	const shown = composeAnswer({ answer: "Done.", trace, view: { ...DEFAULT_VIEW, reasoning: true }, limit: undefined, rich: true });
	assert.match(shown.markdown, /^<details><summary>▸ Reasoning<\/summary>[\s\S]*<\/details>\n\nDone\.$/);
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
	assert.match(rich.markdown, /All done\.\n\n<details><summary>▸ 1 step · write<\/summary>[\s\S]*<\/details>\n\n<details><summary>▸ Changes · 1 file \+1 −1<\/summary>[\s\S]*<\/details>\n\n_m1 · 5% · 4s_$/);
	assert.deepEqual(composeAnswer({ answer: "All done.", trace, view: DEFAULT_VIEW, limit: 1000, rich: false }), {
		markdown: "All done.",
		documents: [],
	});
	const quiet = composeAnswer({ answer: "All done.", trace, view: { ...DEFAULT_VIEW, verbose: "off" }, limit: 1000, rich: true });
	assert.doesNotMatch(quiet.markdown, /<details>/, "verbose off has no steps or changes fold");
	assert.deepEqual(quiet.documents, []);
	const empty = composeAnswer({ answer: undefined, trace: emptyTrace(), view: DEFAULT_VIEW, limit: undefined, rich: true });
	assert.equal(empty.markdown, "", "an empty answer, no steps and no changes leave nothing");
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
	const markdown = "Answer.\n\n<details><summary>▸ 2 steps · read</summary>\n\n- a\n\n</details>\n\n_m1 · 5% · 4s_";
	assert.equal(flattenFolds(markdown), "Answer.\n\n▸ 2 steps · read\n\n- a\n\n\n\n_m1 · 5% · 4s_");
	assert.equal(contextLine(markdown, 100), "Answer.");
});
