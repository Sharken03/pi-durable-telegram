import { basename } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { ChatView, Verbose } from "../channel/docs.ts";
import { codePointCut, truncate } from "../format/escape.ts";
import { closesFence, type FenceOpener, parseFenceOpener } from "../format/fence.ts";
import { stripButtons } from "../format/rich.ts";
import { formatDuration } from "../status/format-status.ts";
import { toolHint } from "./hints.ts";
import { type Step, stepsOf, type Trace } from "./trace.ts";

/** Call lines a draft shows; older calls are counted in one "+N earlier" line. */
export const DRAFT_LINES = 6;
/** An answer longer than this goes out as answer.md, after its start in the message. */
export const LONG_ANSWER_CHARS = 4000;
const START_MAX = 1500;
const REASONING_MAX = 4000;
const STEPS_MAX = 10_000;
const CHANGES_MAX = 10_000;
/** A file whose diff has more lines goes out as a .diff document. */
export const DIFF_LINES_INLINE = 60;
const MINUS = "−";
const ROW = /<tg-button-row\b[^>]*>[\s\S]*?<\/tg-button-row>/gi;

export type OutDocument = { readonly name: string; readonly text: string };
export type Composed = { readonly markdown: string; readonly documents: OutDocument[] };

/**
 * The status block above the streamed text of a draft: the last call lines and the newest text between calls. `rich`
 * escapes Markdown for a rich draft; without it markup characters are dropped (the HTML preview has no escapes).
 */
export function draftStatus(trace: Trace, note: string | undefined, verbose: Verbose, rich = true): string {
	if (verbose === "off") return "";
	const steps = stepsOf(trace);
	const shown = steps.slice(-DRAFT_LINES).map((step) => stepLine(step, verbose, rich));
	const earlier = steps.length - shown.length;
	const lines = earlier > 0 ? [`+${earlier} earlier`, ...shown] : shown;
	const text = note ?? lastText(trace);
	if (text !== undefined && text.trim() !== "") lines.push(`_${plain(text, 120, rich)}_`);
	return lines.join("\n");
}

function lastText(trace: Trace): string | undefined {
	const item = trace.items.findLast((each) => each.kind === "text");
	return item?.kind === "text" ? item.text : undefined;
}

/** One call: an icon (⚙ running or waiting, ✅ ok, ❌ error), what it was called with, and a short result. */
export function stepLine(step: Step, verbose: Verbose, rich = true): string {
	const full = verbose === "full";
	const label = full ? `${step.name} ${argsText(step.args, 200)}` : toolHint(step.name, step.args);
	const result = step.result === undefined || step.status === "pending" ? "" : resultLine(step.result, full, rich);
	return `${icon(step)} ${codeSpan(label)}${result === "" ? "" : ` · ${result}`}`;
}

function icon(step: Step): string {
	if (step.status === "ok") return "✅";
	return step.status === "error" ? "❌" : "⚙";
}

function resultLine(result: string, full: boolean, rich: boolean): string {
	if (full) return plain(result, 200, rich);
	return plain(result.split("\n").find((line) => line.trim() !== "") ?? "", 50, rich);
}

function argsText(args: JsonValue | undefined, max: number): string {
	return args === undefined ? "" : truncate(JSON.stringify(args) ?? "", max);
}

/**
 * One line of text that cannot open Markdown or tags: whitespace collapsed, cut, then markup characters escaped
 * (rich Markdown follows GitHub's, so a backslash escapes any ASCII punctuation) or, for HTML, dropped.
 */
function plain(text: string, max: number, rich = true): string {
	const line = truncate(text.replace(/\s+/g, " ").trim(), max);
	return rich ? line.replace(/[\\`*_~|=<>[\]#]/g, "\\$&") : line.replace(/[\\`*_~|<>[\]]/g, "");
}

function codeSpan(text: string): string {
	const clean = text.replace(/`/g, "'").replace(/\s+/g, " ").trim();
	return clean === "" ? "" : `\`${clean}\``;
}

/** Model text inside a fold: no folds or buttons of its own, which would end or break the outer fold. */
function foldSafe(text: string): string {
	return stripButtons(text)
		.replace(/<\/?(details|summary|tg-thinking)\b[^>]*>/gi, "")
		.trim();
}

function fold(summary: string, body: string): string {
	return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

export function reasoningFold(trace: Trace): string | undefined {
	const text = foldSafe(trace.reasoning.join("\n\n"));
	if (text === "") return undefined;
	return fold("▸ Reasoning", closeOpenFence(cutText(text, REASONING_MAX)));
}

/** All calls of the run and the full text between them; undefined without calls. */
export function stepsFold(trace: Trace, verbose: Verbose): string | undefined {
	const steps = stepsOf(trace);
	if (verbose === "off" || steps.length === 0) return undefined;
	const names = [...new Set(steps.map((step) => step.name))];
	const summary = `▸ ${steps.length} ${steps.length === 1 ? "step" : "steps"} · ${plain(names.join(", "), 80)}`;
	let body = "";
	let previous: "text" | "call" | undefined;
	let shown = 0;
	for (const item of trace.items) {
		const block =
			item.kind === "text" ? closeOpenFence(cutText(foldSafe(item.text), 2000)) : stepItem(item.step, verbose);
		if (block === "") continue;
		if (body.length + block.length > STEPS_MAX) break;
		// Calls in a row form one list; text between them is its own paragraph.
		body += previous === undefined ? block : `${previous === "call" && item.kind === "call" ? "\n" : "\n\n"}${block}`;
		previous = item.kind;
		if (item.kind === "call") shown += 1;
	}
	if (shown < steps.length) body += `\n\n+${steps.length - shown} more`;
	return fold(summary, body);
}

function stepItem(step: Step, verbose: Verbose): string {
	if (verbose !== "full") return `- ${stepLine(step, "on")}`;
	const head = `- ${icon(step)} ${codeSpan(`${step.name} ${argsText(step.args, 300)}`)}`;
	return step.result === undefined || step.result === "" ? head : `${head}\n  - ${plain(step.result, 500)}`;
}

type FileChange = { path: string; patches: string[]; added: number; removed: number; lines: number; kept: boolean };

/** One diff per changed file; a file with a long diff, or past the size of the fold, goes out as a .diff document. */
export function changesFold(trace: Trace): { markdown: string | undefined; documents: OutDocument[] } {
	const files = changedFiles(trace);
	if (files.length === 0) return { markdown: undefined, documents: [] };
	const documents: OutDocument[] = [];
	const names = new Set<string>();
	const blocks: string[] = [];
	let size = 0;
	for (const file of files) {
		const head = `**${codeSpan(file.path)}** +${file.added} ${MINUS}${file.removed}`;
		if (!file.kept) {
			blocks.push(`${head} · diff not kept`);
			continue;
		}
		const body = file.patches.map(hunksOf).join("\n");
		const inline = `${head}\n${codeBlock(body, "diff")}`;
		if (file.lines <= DIFF_LINES_INLINE && size + inline.length <= CHANGES_MAX) {
			blocks.push(inline);
			size += inline.length + 2;
			continue;
		}
		const name = uniqueName(`${basename(file.path) || "changes"}.diff`, names);
		documents.push({ name, text: file.patches.join("\n") });
		blocks.push(`${head} · in ${codeSpan(name)}`);
	}
	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);
	const count = `${files.length} ${files.length === 1 ? "file" : "files"}`;
	return { markdown: fold(`▸ Changes · ${count} +${added} ${MINUS}${removed}`, blocks.join("\n\n")), documents };
}

function changedFiles(trace: Trace): FileChange[] {
	const byPath = new Map<string, FileChange>();
	for (const step of stepsOf(trace)) {
		const path = (step.args as { path?: unknown } | undefined)?.path;
		if (step.status !== "ok" || !["write", "edit"].includes(step.name) || typeof path !== "string") continue;
		const file = byPath.get(path) ?? { path, patches: [], added: 0, removed: 0, lines: 0, kept: true };
		byPath.set(path, file);
		if (step.patch === undefined) {
			file.kept = false;
			continue;
		}
		const counts = countPatch(step.patch);
		file.patches.push(step.patch);
		file.added += counts.added;
		file.removed += counts.removed;
		file.lines += counts.lines;
	}
	return [...byPath.values()].filter((file) => !file.kept || file.lines > 0);
}

/** Added, removed and body lines of a unified diff (file headers are not counted). */
export function countPatch(patch: string): { added: number; removed: number; lines: number } {
	let added = 0;
	let removed = 0;
	let lines = 0;
	for (const line of hunksOf(patch).split("\n")) {
		if (line === "") continue;
		lines += 1;
		if (line.startsWith("+")) added += 1;
		else if (line.startsWith("-")) removed += 1;
	}
	return { added, removed, lines };
}

/** The patch without its `---`/`+++` file header lines. */
function hunksOf(patch: string): string {
	const lines = patch.replace(/\n$/, "").split("\n");
	let start = 0;
	while (start < lines.length && /^(---|\+\+\+|=+$|Index:)/.test(lines[start] ?? "")) start += 1;
	return lines.slice(start).join("\n");
}

function codeBlock(body: string, lang: string): string {
	const longest = Math.max(2, ...[...body.matchAll(/^ {0,3}(`{3,})/gm)].map((match) => match[1]?.length ?? 0));
	const fence = "`".repeat(longest + 1);
	return `${fence}${lang}\n${body}\n${fence}`;
}

function uniqueName(name: string, taken: Set<string>): string {
	let candidate = name;
	for (let n = 2; taken.has(candidate); n++) candidate = name.replace(/(\.diff)$/, `-${n}$1`);
	taken.add(candidate);
	return candidate;
}

/** `model · context % · time`; parts that are not known are left out. */
export function footerLine(trace: Trace, limit: number | undefined): string | undefined {
	const parts: string[] = [];
	if (trace.model !== undefined) parts.push(plain(trace.model, 60));
	if (trace.contextTokens !== undefined && limit !== undefined && limit > 0)
		parts.push(`${Math.round((trace.contextTokens / limit) * 100)}%`);
	if (trace.startedAt !== undefined && trace.endedAt !== undefined && trace.endedAt >= trace.startedAt)
		parts.push(elapsed(trace.endedAt - trace.startedAt));
	return parts.length === 0 ? undefined : `_${parts.join(" · ")}_`;
}

function elapsed(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return formatDuration(ms);
}

/**
 * The start of a long answer, cut at a paragraph outside code and folds (else at a line) and at most `START_MAX`
 * characters, with the answer's button rows; the whole answer goes out as answer.md. A short answer is kept as is.
 */
export function longAnswer(answer: string): { text: string; document?: OutDocument } {
	if (answer.length <= LONG_ANSWER_CHARS) return { text: answer };
	const start = closeOpenFence(answerStart(answer)).trim();
	const rows = [...answer.matchAll(ROW)].map((match) => match[0]);
	const text = [start, "_… the full answer is in answer.md_", ...rows].join("\n\n");
	return { text, document: { name: "answer.md", text: answer } };
}

function answerStart(text: string): string {
	let fence: FenceOpener | undefined;
	let depth = 0;
	let offset = 0;
	let paragraph = 0;
	let line = 0;
	for (const each of text.split("\n")) {
		const end = offset + each.length;
		if (end > START_MAX) break;
		if (fence === undefined && depth === 0 && each.trim() === "") paragraph = offset;
		if (fence === undefined) depth = Math.max(0, depth + tagBalance(each));
		fence = fence === undefined ? parseFenceOpener(each) : closesFence(each, fence) ? undefined : fence;
		// Without a paragraph, any line outside folds and button rows ends the start; an open fence is closed later.
		if (depth === 0) line = end;
		offset = end + 1;
	}
	const cut = paragraph > 0 ? paragraph : line > 0 ? line : codePointCut(text, START_MAX);
	return text.slice(0, cut);
}

function tagBalance(line: string): number {
	let balance = 0;
	for (const match of line.matchAll(/<(\/?)(details|tg-button-row)\b/gi)) balance += match[1] === "/" ? -1 : 1;
	return balance;
}

/** Text cut to `max` characters on a line where possible. */
function cutText(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.lastIndexOf("\n", max);
	return `${text.slice(0, cut > max / 2 ? cut : codePointCut(text, max))}\n…`;
}

/** Close a code fence left open at the end of `text`. */
function closeOpenFence(text: string): string {
	let fence: FenceOpener | undefined;
	for (const line of text.split("\n"))
		fence = fence === undefined ? parseFenceOpener(line) : closesFence(line, fence) ? undefined : fence;
	return fence === undefined ? text : `${text}\n${fence.marker}`;
}

export type ComposeInput = {
	readonly answer: string | undefined;
	readonly trace: Trace;
	readonly view: ChatView;
	/** The context limit for the footer's percentage. */
	readonly limit: number | undefined;
	/**
	 * Rich messages get folds, the footer and the answer.md cut. HTML gets the whole answer only, split into messages
	 * as before: HTML has no folds.
	 */
	readonly rich: boolean;
};

/** The final message: reasoning fold (when shown), answer, steps fold, changes fold and footer, plus documents. */
export function composeAnswer(input: ComposeInput): Composed {
	const { trace, view } = input;
	if (!input.rich) return { markdown: input.answer ?? "", documents: [] };
	const long = input.answer === undefined ? undefined : longAnswer(input.answer);
	const documents: OutDocument[] = long?.document === undefined ? [] : [long.document];
	const changes = changesFold(trace);
	const parts = [
		view.reasoning ? reasoningFold(trace) : undefined,
		long?.text,
		stepsFold(trace, view.verbose),
		changes.markdown,
		footerLine(trace, input.limit),
	];
	return { markdown: join(parts), documents: [...documents, ...changes.documents] };
}

function join(parts: readonly (string | undefined)[]): string {
	return parts.filter((part): part is string => part !== undefined && part.trim() !== "").join("\n\n");
}
