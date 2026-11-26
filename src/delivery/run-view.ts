import { basename, normalize } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { ChatView, DiffFile, Verbose } from "../channel/docs.ts";
import { codePointCut, escapeHtml, truncate } from "../format/escape.ts";
import { closesFence, type FenceOpener, parseFenceOpener } from "../format/fence.ts";
import { stripButtons } from "../format/rich.ts";
import { formatDuration } from "../status/format-status.ts";
import { SEND_FILE_TOOL } from "../telegram/send-file.ts";
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
/** The changes fold shows this many lines of a file's diff; the Full diff button under the answer sends the rest. */
export const DIFF_LINES_INLINE = 60;
/** Data of the Full diff buttons: `ork:diff:<n>` sends the n-th kept diff, `ork:diff:all` all of them in one file. */
export const DIFF_DATA = "ork:diff:";
/** At most this many Full diff buttons, one per file; more files with long diffs share one button. */
const DIFF_BUTTONS = 3;
/** The diffs kept for the buttons of one answer stay under this many characters. */
const DIFFS_KEPT_MAX = 512 * 1024;
const MINUS = "−";
const ROW = /<tg-button-row\b[^>]*>[\s\S]*?<\/tg-button-row>/gi;

export type OutDocument = { readonly name: string; readonly text: string };
/** The final message, the documents after it (answer.md), and the diffs its Full diff buttons send. */
export type Composed = { readonly markdown: string; readonly documents: OutDocument[]; readonly diffs: DiffFile[] };

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

/**
 * One call: an icon (⚙ running or waiting, ✅ ok, ❌ error), what it was called with, and a short result. A file the
 * model sent to the chat is one short line in every mode.
 */
export function stepLine(step: Step, verbose: Verbose, rich = true): string {
	if (isSentFile(step)) return `📎 ${codeSpan(basename(pathOf(step) ?? "file"))} · sent`;
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
	return fold("Reasoning", closeOpenFence(cutText(text, REASONING_MAX)));
}

/** All calls of the run and the full text between them; undefined without calls. */
export function stepsFold(trace: Trace, verbose: Verbose): string | undefined {
	const steps = stepsOf(trace);
	if (verbose === "off" || steps.length === 0) return undefined;
	const names = [...new Set(steps.map((step) => step.name))];
	const summary = `${steps.length} ${steps.length === 1 ? "step" : "steps"} · ${plain(names.join(", "), 80)}`;
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
	if (verbose !== "full" || isSentFile(step)) return `- ${stepLine(step, "on")}`;
	const head = `- ${icon(step)} ${codeSpan(`${step.name} ${argsText(step.args, 300)}`)}`;
	return step.result === undefined || step.result === "" ? head : `${head}\n  - ${plain(step.result, 500)}`;
}

function pathOf(step: Step): string | undefined {
	const path = (step.args as { path?: unknown } | undefined)?.path;
	return typeof path === "string" && path !== "" ? path : undefined;
}

function isSentFile(step: Step): boolean {
	return step.name === SEND_FILE_TOOL && step.status === "ok";
}

type FileChange = {
	path: string;
	patches: string[];
	added: number;
	removed: number;
	/** Diff body lines of all patches. */
	lines: number;
	/** Every change of the file has a patch. */
	kept: boolean;
	/** The run made the file; `size` is its line count at the end of the run. */
	created?: { size: number };
	/** The model sent the file to the chat. */
	sent: boolean;
};

/** The changes fold, the row of Full diff buttons for under the answer, and the diffs the buttons send by index. */
export type Changes = { readonly markdown?: string; readonly row?: string; readonly diffs: DiffFile[] };

/**
 * One block per changed file: a new file is one line with its line count; a changed file shows the first
 * `DIFF_LINES_INLINE` lines of its diff, and a longer diff gets a Full diff button (none for a file the model sent).
 */
export function changesFold(trace: Trace): Changes {
	const files = changedFiles(trace);
	if (files.length === 0) return { diffs: [] };
	const diffs: DiffFile[] = [];
	const names = new Set<string>();
	const long: number[] = [];
	const blocks: string[] = [];
	let size = 0;
	let kept = 0;
	for (const file of files) {
		const path = `**${codeSpan(file.path)}**`;
		const sent = file.sent ? " · sent" : "";
		if (file.created !== undefined) {
			const lines = file.kept ? `, ${count(file.created.size, "line")}` : "";
			blocks.push(`${path} · new file${lines}${sent}`);
			continue;
		}
		const head = `${path} +${file.added} ${MINUS}${file.removed}${sent}`;
		if (!file.kept) {
			blocks.push(`${head} · diff not kept`);
			continue;
		}
		const text = joinPatches(file.patches);
		const index = kept + text.length <= DIFFS_KEPT_MAX ? diffs.length : undefined;
		if (index !== undefined) {
			diffs.push({ name: uniqueName(`${basename(file.path) || "changes"}.diff`, names), text });
			kept += text.length;
		}
		const body = file.patches.map(hunksOf).join("\n").split("\n");
		const more = body.length - DIFF_LINES_INLINE;
		const note = more > 0 ? `\n_… ${count(more, "more line")}_` : "";
		const excerpt = `${head}\n${codeBlock(body.slice(0, DIFF_LINES_INLINE).join("\n"), "diff")}${note}`;
		const fits = size + excerpt.length <= CHANGES_MAX;
		blocks.push(fits ? excerpt : `${head} · ${count(body.length, "line")}`);
		if (fits) size += excerpt.length + 2;
		if ((more > 0 || !fits) && index !== undefined && !file.sent) long.push(index);
	}
	// A new file adds its lines; one with a change that has no patch adds nothing, as its count is not known.
	const created = (file: FileChange) => (file.kept ? (file.created?.size ?? 0) : 0);
	const added = files.reduce((sum, file) => sum + (file.created === undefined ? file.added : created(file)), 0);
	const removed = files.reduce((sum, file) => sum + (file.created === undefined ? file.removed : 0), 0);
	const markdown = fold(`Changes · ${count(files.length, "file")} +${added} ${MINUS}${removed}`, blocks.join("\n\n"));
	const row = diffRow(long, diffs);
	return row === undefined ? { markdown, diffs: [] } : { markdown, row, diffs };
}

function count(n: number, noun: string): string {
	return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/** Patches one after another as one unified diff. */
function joinPatches(patches: readonly string[]): string {
	return patches.map((patch) => (patch.endsWith("\n") ? patch : `${patch}\n`)).join("");
}

/** One Full diff button per long diff, each in its own row; more than `DIFF_BUTTONS` share one button. */
function diffRow(long: readonly number[], diffs: readonly DiffFile[]): string | undefined {
	if (long.length === 0) return undefined;
	if (long.length > DIFF_BUTTONS) return diffButton(`Full diff · ${count(diffs.length, "file")}`, "all");
	if (long.length === 1) return diffButton("Full diff", String(long[0]));
	const name = (index: number) => truncate((diffs[index]?.name ?? "").replace(/\.diff$/, ""), 24);
	return long.map((index) => diffButton(`Full diff · ${name(index)}`, String(index))).join("\n");
}

function diffButton(label: string, which: string): string {
	const button = `<tg-button type="callback_data" data="${DIFF_DATA}${which}">${escapeHtml(label)}</tg-button>`;
	return `<tg-button-row>${button}</tg-button-row>`;
}

/** The diff a Full diff button's data names: one kept file, or all of them as `changes.diff`. */
export function diffFor(files: readonly DiffFile[] | undefined, which: string): DiffFile | undefined {
	if (files === undefined || files.length === 0) return undefined;
	if (which === "all") return { name: "changes.diff", text: joinPatches(files.map((file) => file.text)) };
	return /^\d+$/.test(which) ? files[Number(which)] : undefined;
}

function changedFiles(trace: Trace): FileChange[] {
	const byPath = new Map<string, FileChange>();
	const sent = stepsOf(trace).filter(isSentFile).flatMap((step) => pathOf(step) ?? []);
	for (const step of stepsOf(trace)) {
		const path = pathOf(step);
		if (step.status !== "ok" || !["write", "edit"].includes(step.name) || path === undefined) continue;
		let file = byPath.get(path);
		if (file === undefined || step.created !== undefined) {
			const wasSent = sent.some((each) => samePath(each, path));
			file = { path, patches: [], added: 0, removed: 0, lines: 0, kept: true, sent: wasSent };
			byPath.set(path, file);
		}
		if (step.created !== undefined) {
			file.created = { size: step.created.lines };
			continue;
		}
		if (step.patch === undefined) {
			file.kept = false;
			continue;
		}
		const counts = countPatch(step.patch);
		// A new file stays new: later changes only move its line count.
		if (file.created !== undefined) {
			file.created.size += counts.added - counts.removed;
			continue;
		}
		file.patches.push(step.patch);
		file.added += counts.added;
		file.removed += counts.removed;
		file.lines += counts.lines;
	}
	return [...byPath.values()].filter((file) => file.created !== undefined || !file.kept || file.lines > 0);
}

/** The same file: the same path, or an absolute path that ends in the other, relative one. */
function samePath(a: string, b: string): boolean {
	const [x, y] = [normalize(a), normalize(b)];
	const ends = (full: string, part: string) =>
		full.startsWith("/") && !part.startsWith("/") && full.endsWith(`/${part}`);
	return x === y || ends(x, y) || ends(y, x);
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

/**
 * The final message: reasoning fold (when shown), answer, steps fold, changes fold, Full diff buttons and footer; plus
 * answer.md for a long answer.
 */
export function composeAnswer(input: ComposeInput): Composed {
	const { trace, view } = input;
	if (!input.rich) return { markdown: input.answer ?? "", documents: [], diffs: [] };
	const long = input.answer === undefined ? undefined : longAnswer(input.answer);
	const documents: OutDocument[] = long?.document === undefined ? [] : [long.document];
	// Verbose off is the answer and the footer only: no steps, no changes.
	const changes: Changes = view.verbose === "off" ? { diffs: [] } : changesFold(trace);
	const parts = [
		view.reasoning ? reasoningFold(trace) : undefined,
		long?.text,
		stepsFold(trace, view.verbose),
		changes.markdown,
		changes.row,
		footerLine(trace, input.limit),
	];
	return { markdown: join(parts), documents, diffs: changes.diffs };
}

function join(parts: readonly (string | undefined)[]): string {
	return parts.filter((part): part is string => part !== undefined && part.trim() !== "").join("\n\n");
}
