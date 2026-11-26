import type { Context, JsonValue } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Cursor,
	type EntryId,
	type EntryQuery,
	type EntryRecord,
	type Page,
	ToolResultEntry,
	UserEntry,
} from "@earendil-works/pi-durable";
import { truncate } from "../format/escape.ts";
import { emptyTrace, type FileFacts, PATCH_MAX, RESULT_MAX, type Step, type Trace } from "./trace.ts";

const PAGE = 20;

/** The part of `TaskRuntime` that reads a conversation's entries. */
export type EntryReader = {
	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;
};

type Part = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: JsonValue };

/**
 * Builds a `Trace` from pi-durable entries in ID order: assistant entries give calls, the text between calls and the
 * reasoning; tool result entries settle calls; the first user entry gives the start time. An assistant message
 * without calls is the answer: it gives the model and the context size, not text. The end time is the caller's.
 */
export class TraceBuilder {
	readonly trace: Trace = emptyTrace();
	readonly #calls = new Map<string, Step>();
	#lastId: number | undefined;

	get lastId(): number | undefined {
		return this.#lastId;
	}

	add(entry: EntryRecord): void {
		this.#lastId = Number(entry.id);
		const message = entry.model?.[0] as Message | undefined;
		if (message === undefined) return;
		if (UserEntry.is(entry) && message.role === "user") this.trace.startedAt ??= message.timestamp;
		else if (AssistantEntry.is(entry) && message.role === "assistant") this.#assistant(message);
		else if (ToolResultEntry.is(entry) && message.role === "toolResult") this.#result(message);
	}

	/** The call with `id`, added when no entry has named it yet (a live slot). */
	call(id: string, name: string, args: JsonValue | undefined): Step {
		const known = this.#calls.get(id);
		if (known !== undefined) return known;
		const step: Step = { id, name, args, status: "pending" };
		this.#calls.set(id, step);
		this.trace.items.push({ kind: "call", step });
		return step;
	}

	#assistant(message: Extract<Message, { role: "assistant" }>): void {
		const parts = message.content as unknown as readonly Part[];
		const calling = parts.some((part) => part.type === "toolCall");
		for (const part of parts) {
			if (part.type === "thinking" && part.thinking?.trim()) this.trace.reasoning.push(part.thinking.trim());
			else if (part.type === "text" && calling && part.text?.trim())
				this.trace.items.push({ kind: "text", text: part.text.trim() });
			else if (part.type === "toolCall" && part.id !== undefined) {
				const step = this.call(part.id, part.name ?? "tool", part.arguments);
				step.args = part.arguments;
			}
		}
		if (calling) return;
		const usage = message.usage;
		this.trace.model = message.model;
		this.trace.provider = message.provider;
		if (message.thinkingLevel !== undefined) this.trace.effort = message.thinkingLevel;
		const sum = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
		this.trace.contextTokens = usage.totalTokens > 0 ? usage.totalTokens : sum;
	}

	#result(message: Extract<Message, { role: "toolResult" }>): void {
		const step = this.call(message.toolCallId, message.toolName, undefined);
		step.status = message.isError ? "error" : "ok";
		step.result = truncate(resultText(message.content).trim(), RESULT_MAX);
		const details = message.details as { patch?: unknown; created?: unknown; lines?: unknown } | undefined;
		const patch = details?.patch;
		if (typeof patch === "string" && patch.length <= PATCH_MAX && patch.trim() !== "") step.patch = patch;
		if (details?.created === true && typeof details.lines === "number") step.created = { lines: details.lines };
		const file = message.isError ? undefined : fileFacts(step, message.content);
		if (file !== undefined) step.file = file;
	}
}

/** The harness adds its notes (truncation, more lines) as a last text part. */
const HARNESS_NOTE = /^<harness>\n/;

/**
 * Facts of a settled read, write or edit of pi-durable's file tools: lines read (with the range and the file's line
 * count from the harness note), lines written, or blocks replaced. Undefined for other tools and for an image read.
 */
function fileFacts(step: Step, content: readonly { type: string; text?: string }[]): FileFacts | undefined {
	const args = (step.args ?? {}) as { content?: unknown; offset?: unknown; edits?: unknown };
	const texts = content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []));
	const last = texts.at(-1);
	const note = last !== undefined && HARNESS_NOTE.test(last) ? last : undefined;
	if (step.name === "write") return typeof args.content === "string" ? { lines: lineCount(args.content) } : undefined;
	if (step.name === "edit") {
		const replaced = texts[0]?.match(/\breplaced (\d+) block/);
		const blocks = replaced === null || replaced === undefined ? undefined : Number(replaced[1]);
		if (blocks !== undefined) return { blocks };
		return Array.isArray(args.edits) ? { blocks: args.edits.length } : undefined;
	}
	if (step.name !== "read" || content.some((part) => part.type !== "text")) return undefined;
	const body = note === undefined ? texts : texts.slice(0, -1);
	const lines = lineCount(body.join("\n"));
	const from = typeof args.offset === "number" && args.offset > 1 ? Math.floor(args.offset) : 1;
	const shown = note?.match(/Showing lines \d+-\d+ of (\d+)/);
	const more = note?.match(/(\d+) more lines in file/);
	const total =
		shown !== null && shown !== undefined
			? Number(shown[1])
			: more !== null && more !== undefined
				? from + lines - 1 + Number(more[1])
				: undefined;
	return { lines, from, ...(total === undefined ? {} : { total }) };
}

/** Lines of a text; a last newline ends the last line and adds no empty one. */
function lineCount(text: string): number {
	if (text === "") return 0;
	const lines = text.split("\n");
	return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/**
 * A tool result as text. The harness note shows only its messages: a failed call's error is only in the note, and its
 * `<harness>` tag would else be the first line.
 */
function resultText(content: readonly { type: string; text?: string }[]): string {
	return content.map((part) => (part.type === "text" ? noteFree(part.text ?? "") : `[${part.type}]`)).join("\n");
}

function noteFree(text: string): string {
	const note = text.match(/^<harness>\n([\s\S]*)\n<\/harness>$/);
	return note === null ? text : (note[1] ?? "").replace(/^\[(?:info|warn|error)\] /gm, "");
}

/** Feed every entry from `from` to `to` (inclusive, `to` open when undefined) to `each`, oldest first, by pages. */
export async function readEntries(
	reader: EntryReader,
	from: number,
	to: number | undefined,
	context: Context,
	each: (entry: EntryRecord) => void,
): Promise<void> {
	const query: Omit<EntryQuery, "conversationId"> = {
		minEntryId: from as EntryId,
		...(to === undefined ? {} : { maxEntryId: to as EntryId }),
		order: "ascending",
	};
	let cursor: Cursor | undefined;
	do {
		const page = await reader.entries(query, PAGE, cursor, context);
		for (const entry of page.items) each(entry);
		cursor = page.next;
	} while (cursor !== undefined);
}

/** The trace of a finished run: its entries from the user's message to the answer. */
export async function readTrace(reader: EntryReader, from: number, to: number, context: Context): Promise<Trace> {
	const builder = new TraceBuilder();
	await readEntries(reader, from, to, context, (entry) => builder.add(entry));
	return builder.trace;
}
