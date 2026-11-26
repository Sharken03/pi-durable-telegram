import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { createWriteTool } from "@earendil-works/pi-durable/tools";

/** An older file larger than this is not read for a diff: the result then has no patch. */
const MAX_BEFORE_BYTES = 512 * 1024;
const CONTEXT_LINES = 3;

/**
 * `write` that also returns a unified diff of the change in `details.patch`, as `edit` does, so the chat can show
 * what changed. The diff never reaches the model; the write itself is the stock tool's.
 */
export function createDiffWriteTool(): ToolRegistration {
	const write = createWriteTool() as unknown as ToolRegistration;
	return {
		...write,
		execute: async (args, api, context) => {
			const { path, content } = args as { path: unknown; content: unknown };
			const before = typeof path === "string" ? await readBefore(api, path, context) : undefined;
			const result = await write.execute(args, api, context);
			if (before === undefined || result.isError === true || typeof content !== "string") return result;
			const patch = linePatch(String(path), before, content);
			return patch === undefined ? result : { ...result, details: { patch } };
		},
	};
}

/** The file's text before the write: "" for a new file, undefined when it cannot be read or is too large. */
async function readBefore(api: ToolExecutionApi, path: string, context: Context): Promise<string | undefined> {
	const env = api.env;
	if (env === undefined) return undefined;
	const exists = await env.exists(path, context);
	if (!exists.ok) return undefined;
	if (!exists.value) return "";
	const info = await env.fileInfo(path, context);
	if (!info.ok || info.value.kind !== "file" || info.value.size > MAX_BEFORE_BYTES) return undefined;
	const text = await env.readTextFile(path, context);
	return text.ok ? text.value : undefined;
}

/**
 * A unified diff with one hunk: the lines between the common start and the common end of the two texts, with up to
 * three lines of context. Not minimal for scattered changes, but correct, and linear in the file size. Undefined when
 * nothing changed.
 */
export function linePatch(path: string, before: string, after: string): string | undefined {
	if (before === after) return undefined;
	const old = splitLines(before);
	const next = splitLines(after);
	let head = 0;
	while (head < old.length && head < next.length && old[head] === next[head]) head += 1;
	let tail = 0;
	while (
		tail < old.length - head &&
		tail < next.length - head &&
		old[old.length - 1 - tail] === next[next.length - 1 - tail]
	)
		tail += 1;
	const from = Math.max(0, head - CONTEXT_LINES);
	const trailing = Math.min(tail, CONTEXT_LINES);
	const oldEnd = old.length - tail + trailing;
	const newEnd = next.length - tail + trailing;
	const lines = [
		...old.slice(from, head).map((line) => ` ${line}`),
		...old.slice(head, old.length - tail).map((line) => `-${line}`),
		...next.slice(head, next.length - tail).map((line) => `+${line}`),
		...old.slice(old.length - tail, oldEnd).map((line) => ` ${line}`),
	];
	const range = (start: number, end: number) => `${end - start === 0 ? start : start + 1},${end - start}`;
	return [`--- ${path}`, `+++ ${path}`, `@@ -${range(from, oldEnd)} +${range(from, newEnd)} @@`, ...lines, ""].join(
		"\n",
	);
}

function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}
