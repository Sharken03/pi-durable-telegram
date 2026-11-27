import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	InboxDoc,
	type NextTaskState,
	type RunningTask,
	type TaskRuntime,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import {
	Buttons,
	DEFAULT_VIEW,
	Delivered,
	type DiffFile,
	Diffs,
	Retries,
	rememberButtons,
	rememberDiffs,
	rememberRetry,
} from "../channel/docs.ts";
import { type Chunk, splitForTelegram } from "../format/chunk.ts";
import { escapeHtml } from "../format/escape.ts";
import { flattenFolds, hasCallbackButtons, shortenButtonsData, splitRich, stripButtons } from "../format/rich.ts";
import { errorSummary } from "../runtime/log.ts";
import { classifyTelegramError, isBadRequest, telegramErrorSummary } from "../telegram/errors.ts";
import type { InlineButton, TelegramPort } from "../telegram/port.ts";
import { finalReplyText } from "./final-text.ts";
import { stallsQueue, unansweredText } from "./outcome.ts";
import { withPlainFallback } from "./preview.ts";
import { readTrace } from "./run-entries.ts";
import { composeAnswer, DIFF_DATA, type OutDocument } from "./run-view.ts";
import { emptyTrace, stepsOf, type Trace } from "./trace.ts";
import type { DeliverInput, DeliverState, DeliveryDeps, Outcome, SendState } from "./types.ts";
import { terminal } from "./wait-phase.ts";

type Runtime = TaskRuntime<DeliverInput, DeliverState, null, object>;
type Next = NextTaskState<DeliverState, null>;
type Task = RunningTask<DeliverInput, SendState, null>;

const MAX_RATE_LIMIT_WAITS = 5;
/** Pauses between attempts of the final preview edit while Telegram is unreachable; then a new message is sent. */
export const EDIT_RETRY_DELAYS_MS: readonly number[] = [2000, 4000, 8000, 16000, 30000];
export const STOPPED_TEXT = "⏹ stopped";
export const SHARED_TEXT = "↑ answered above";
export const EMPTY_TEXT = "(empty answer)";
/** Callback data of the buttons under an error message. */
export const RETRY_DATA = "ork:retry";
export const STOP_DATA = "ork:stop";
const ERROR_BUTTONS: readonly (readonly InlineButton[])[] = [
	[
		{ text: "Retry", data: RETRY_DATA },
		{ text: "Stop", data: STOP_DATA },
	],
];

/**
 * A chunk of the outcome: a message (rich or HTML), or a document sent after the message. `retry`: an error message
 * with Retry and Stop buttons; its request is kept so Retry can send it again. `diffs`: what the Full diff buttons of
 * the message send, kept with it. `silent`: status, not an answer.
 */
type Piece = Chunk & {
	readonly buttons?: readonly (readonly InlineButton[])[];
	readonly retry?: boolean;
	readonly diffs?: DiffFile[];
	readonly silent?: boolean;
	readonly document?: OutDocument;
};

type Job = {
	task: Task;
	runtime: Runtime;
	context: Context;
	deps: DeliveryDeps;
	port: TelegramPort;
	/** The run's trace, read once per invocation. */
	trace?: Trace;
};

/**
 * Phase `send`: render the outcome and deliver it chunk by chunk with durable progress. Chunk 0 edits the preview
 * when there is one (idempotent); other sends are guarded by `inFlight`. A crash between a send and its record skips
 * a later chunk instead of sending it twice, but sends chunk 0 again: a rare duplicate beats a lost answer.
 */
export async function sendPhase(task: Task, runtime: Runtime, context: Context, deps: DeliveryDeps): Promise<void> {
	const job: Job = { task, runtime, context, deps, port: deps.port() };
	let state = task.state.checkpoint;
	let chunks = await renderOutcome(job, state);
	while (state.sent < chunks.length) {
		const next = await deliverChunk(job, state.sent, chunks[state.sent] as Piece, state);
		if (next === undefined) return;
		if (next.htmlFrom !== state.htmlFrom) chunks = await renderOutcome(job, next);
		state = next;
	}
	await finish(job, state);
}

async function renderOutcome(job: Job, state: SendState): Promise<Piece[]> {
	const { outcome, preview } = state;
	if (outcome.kind === "answer") return renderAnswer(job, state, outcome);
	if (outcome.kind === "shared") return preview === undefined ? [] : [{ ...plainChunk(SHARED_TEXT), silent: true }];
	const text = unansweredText(outcome.reason, outcome.detail, job.deps.model);
	if (text !== undefined && outcome.reason === "reset") return [plainChunk(text)];
	if (text !== undefined) return [{ ...plainChunk(text), buttons: ERROR_BUTTONS, retry: true }];
	return outcome.reason === "aborted" && preview !== undefined ? [{ ...plainChunk(STOPPED_TEXT), silent: true }] : [];
}

/** The answer with its folds and footer as messages, then answer.md for a long answer. */
async function renderAnswer(job: Job, state: SendState, outcome: Extract<Outcome, { kind: "answer" }>) {
	const entry = await job.runtime.entry(AssistantEntry, outcome.entryId as never, job.context);
	const rich = job.deps.rich === true;
	// HTML shows the answer only, so it needs no trace.
	const trace = rich ? { ...(await traceOf(job, outcome)) } : emptyTrace();
	if (state.endedAt !== undefined) trace.endedAt = state.endedAt;
	const answer = finalReplyText(entry?.model?.[0]);
	const empty = answer === undefined && (!rich || stepsOf(trace).length === 0);
	const { provider, model } = trace;
	const known = provider !== undefined && model !== undefined;
	const limit = known ? job.deps.contextLimit?.(provider, model) : undefined;
	const effort = (trace.effort ?? "off") as ModelThinkingLevel;
	const preset = known ? job.deps.presetName?.(provider, model, effort) : undefined;
	if (preset !== undefined) trace.preset = preset;
	const composed = composeAnswer({
		answer: empty ? EMPTY_TEXT : answer,
		trace,
		view: state.view ?? DEFAULT_VIEW,
		limit,
		rich,
	});
	const documents = composed.documents.map((document): Piece => ({ html: "", plain: "", document, silent: true }));
	const chunks: Piece[] = answerChunks(composed.markdown, rich, state.htmlFrom);
	// The diffs go with the rich message that carries their buttons; HTML drops the buttons.
	const holder = chunks.findIndex((chunk) => chunk.rich?.includes(`data="${DIFF_DATA}`) === true);
	const { diffs } = composed;
	if (holder >= 0 && diffs.length > 0) chunks[holder] = { ...(chunks[holder] as Piece), diffs };
	return [...chunks, ...documents];
}

/** The run's trace from the user's entry to the answer; empty for a state without `from` (an earlier version). */
async function traceOf(job: Job, outcome: Extract<Outcome, { kind: "answer" }>): Promise<Trace> {
	if (job.trace !== undefined) return job.trace;
	const trace =
		outcome.from === undefined
			? emptyTrace()
			: await readTrace(job.runtime, outcome.from, outcome.entryId, job.context).catch((error: unknown) => {
					if (job.runtime.signal.aborted) throw error;
					job.deps.log.warn("trace_read_failed", { error: errorSummary(error) });
					return emptyTrace();
				});
	job.trace = trace;
	return trace;
}

/** Rich messages up to `htmlFrom`, Telegram HTML from there on (buttons as labels); HTML only without rich mode. */
function answerChunks(text: string, rich: boolean, htmlFrom: number | undefined): Chunk[] {
	if (!rich) return splitForTelegram(text);
	const parts = splitRich(shortenButtonsData(text));
	const from = Math.min(htmlFrom ?? parts.length, parts.length);
	const html = splitForTelegram(flattenFolds(stripButtons(parts.slice(from).join("\n\n"))));
	return [...parts.slice(0, from).map((markdown) => ({ rich: markdown, html: "", plain: markdown })), ...html];
}

function plainChunk(text: string): Chunk {
	return { html: escapeHtml(text), plain: text };
}

type Sent =
	| { kind: "sent"; messageId: number }
	| { kind: "unknown" }
	| { kind: "failed" }
	| { kind: "gone" }
	| { kind: "rejected" };
type Edited = Sent | { kind: "unavailable" };

async function deliverChunk(job: Job, index: number, chunk: Piece, state: SendState): Promise<SendState | undefined> {
	const preview = state.preview;
	if (index === 0 && preview !== undefined && state.previewSkipped !== true && chunk.document === undefined) {
		const edited = await editWithRetries(job, preview.messageId, chunk, state);
		if (edited === undefined) return undefined;
		if (edited.kind !== "gone") return record(job, state, index, edited, chunk);
		state = { ...state, previewSkipped: true, rateLimitWaits: 0 };
	}
	if (state.inFlight === index && index > 0) {
		job.deps.log.warn("delivery_unknown", { chat: job.task.input.chatId, chunk: index, reason: "restart during send" });
		return record(job, state, index, { kind: "unknown" });
	}
	const marked: SendState = { ...state, inFlight: index };
	await save(job, marked);
	const attempt = await attemptOnce(
		job,
		() => sendNew(job, chunk, index === 0),
		(state.rateLimitWaits ?? 0) < MAX_RATE_LIMIT_WAITS,
	);
	// A confirmed 429 sent nothing: clear the uncertain-send marker before sleeping.
	if (attempt.retryAfterMs !== undefined) return sleepBeforeRetry(job, state, attempt.retryAfterMs, true);
	return record(job, marked, index, attempt.sent, chunk);
}

/** Idempotent edits may retry after an outage; counters are carried by the sleeping checkpoint. */
async function editWithRetries(job: Job, messageId: number, chunk: Piece, state: SendState): Promise<Sent | undefined> {
	const attempt = await attemptOnce(
		job,
		() => editPreview(job, messageId, chunk),
		(state.rateLimitWaits ?? 0) < MAX_RATE_LIMIT_WAITS,
	);
	if (attempt.retryAfterMs !== undefined) return sleepBeforeRetry(job, state, attempt.retryAfterMs, true);
	if (attempt.sent.kind !== "unavailable") return attempt.sent;
	const attempts = state.editAttempts ?? 0;
	const delay = (job.deps.editRetryDelaysMs ?? EDIT_RETRY_DELAYS_MS)[attempts];
	if (delay !== undefined)
		return sleepBeforeRetry(job, { ...state, editAttempts: attempts + 1, rateLimitWaits: 0 }, delay);
	job.deps.log.warn("preview_edit_gave_up", { chat: job.task.input.chatId, attempts: attempts + 1 });
	return { kind: "gone" };
}

async function sleepBeforeRetry(job: Job, state: SendState, delay: number, rateLimited = false): Promise<undefined> {
	const { inFlight: _cleared, ...rest } = state;
	const checkpoint = rateLimited ? { ...rest, rateLimitWaits: (state.rateLimitWaits ?? 0) + 1 } : rest;
	await job.runtime.sleepUntil(job.runtime.now() + delay, checkpoint, job.context);
	return undefined;
}

/**
 * Commit the chunk's outcome. In the same commit, a sent rich chunk with the model's callback buttons keeps its
 * Markdown, a sent chunk with Full diff buttons keeps its diffs, and a sent error message keeps its request for Retry.
 */
async function record(job: Job, state: SendState, index: number, sent: Sent, chunk?: Piece): Promise<SendState> {
	const { inFlight: _cleared, editAttempts: _edits, rateLimitWaits: _waits, previewSkipped: _skipped, ...rest } = state;
	// A refused rich message sent nothing: the same chunk index is delivered again as HTML.
	const next: SendState = sent.kind === "rejected" ? { ...rest, htmlFrom: index } : { ...rest, sent: index + 1 };
	if (sent.kind === "sent") next.messageIds = [...state.messageIds, sent.messageId];
	if (sent.kind === "unknown" || state.unknown === true) next.unknown = true;
	if (sent.kind !== "sent" || chunk === undefined) {
		await save(job, next);
		return next;
	}
	const markdown = chunk.rich;
	const { diffs } = chunk;
	const id = job.runtime.conversationId;
	const { content, messageId } = job.task.input;
	const retry = messageId === undefined ? { content } : { content, replyTo: messageId };
	await save(job, next, async (tx) => {
		if (chunk.retry === true) rememberRetry(await tx.doc(Retries, id), sent.messageId, retry);
		if (markdown !== undefined && hasCallbackButtons(markdown))
			rememberButtons(await tx.doc(Buttons, id), sent.messageId, markdown);
		if (diffs !== undefined) rememberDiffs(await tx.doc(Diffs, id), sent.messageId, diffs);
	});
	return next;
}

async function save(job: Job, state: SendState, write?: (tx: Tx) => Promise<void>): Promise<void> {
	await job.runtime.commit(async (tx): Promise<Next> => {
		await write?.(tx);
		return { status: "running", checkpoint: state };
	}, job.context);
}

async function editPreview(job: Job, messageId: number, chunk: Piece): Promise<Edited> {
	try {
		await editChunk(job, messageId, chunk);
		return { kind: "sent", messageId };
	} catch (error) {
		const kind = classifyTelegramError(error).kind;
		if (kind === "not_modified") return { kind: "sent", messageId };
		if (kind === "message_gone") return { kind: "gone" };
		if (kind === "unavailable") return { kind: "unavailable" };
		if (chunk.rich !== undefined && isBadRequest(error)) return rejected(job, error);
		throw error;
	}
}

function editChunk(job: Job, messageId: number, chunk: Piece): Promise<void> {
	const { port } = job;
	const { chatId } = job.task.input;
	const signal = job.runtime.signal;
	const buttons = chunk.buttons === undefined ? {} : { buttons: chunk.buttons };
	if (chunk.rich !== undefined)
		return port.editMessageText(chatId, messageId, chunk.rich, { rich: true, ...buttons }, signal);
	return withPlainFallback(
		() => port.editMessageText(chatId, messageId, chunk.html, { html: true, ...buttons }, signal),
		() => port.editMessageText(chatId, messageId, chunk.plain, buttons, signal),
	);
}

function rejected(job: Job, error: unknown): Sent {
	job.deps.log.warn("rich_rejected", { chat: job.task.input.chatId, ...telegramErrorSummary(error) });
	return { kind: "rejected" };
}

async function sendNew(job: Job, chunk: Piece, first: boolean): Promise<Sent> {
	const { port } = job;
	const { chatId, messageId, threadId } = job.task.input;
	const signal = job.runtime.signal;
	const replyTo = {
		...(first && messageId !== undefined ? { replyTo: messageId } : {}),
		...(threadId === undefined ? {} : { threadId }),
		...(chunk.silent === true ? { silent: true } : {}),
		...(chunk.buttons === undefined ? {} : { buttons: chunk.buttons }),
	};
	const document = chunk.document;
	if (document !== undefined) {
		const id = await port.sendTextDocument(chatId, document.name, document.text, replyTo, signal);
		return { kind: "sent", messageId: id };
	}
	if (chunk.rich !== undefined) {
		const rich = chunk.rich;
		return port.sendMessage(chatId, rich, { rich: true, ...replyTo }, signal).then(
			(id): Sent => ({ kind: "sent", messageId: id }),
			(error: unknown) => (isBadRequest(error) ? rejected(job, error) : Promise.reject(error)),
		);
	}
	const id = await withPlainFallback(
		() => port.sendMessage(chatId, chunk.html, { html: true, ...replyTo }, signal),
		() => port.sendMessage(chatId, chunk.plain, replyTo, signal),
	);
	return { kind: "sent", messageId: id };
}

type Attempt<T> = { sent: T | Sent; retryAfterMs?: undefined } | { retryAfterMs: number };

async function attemptOnce<T extends Edited>(job: Job, call: () => Promise<T>, mayWait: boolean): Promise<Attempt<T>> {
	try {
		return { sent: await call() };
	} catch (error) {
		const kind = classifyTelegramError(error);
		if (kind.kind === "aborted" || job.runtime.signal.aborted) throw error;
		if (kind.kind === "retry_after" && mayWait) return { retryAfterMs: kind.seconds * 1000 };
		return { sent: failed(job, error, kind.kind) };
	}
}

function failed(job: Job, error: unknown, kind: string): Sent {
	const fields = { chat: job.task.input.chatId, kind, ...telegramErrorSummary(error) };
	if (kind === "unknown" || kind === "unavailable") {
		job.deps.log.warn("delivery_unknown", fields);
		return { kind: "unknown" };
	}
	job.deps.log.warn("delivery_failed", fields);
	return { kind: "failed" };
}

async function finish(job: Job, state: SendState): Promise<void> {
	const outcome = state.outcome;
	if (outcome.kind === "unanswered" && stallsQueue(outcome.reason)) await unstickQueue(job, outcome);
	await job.runtime.commit(async (tx): Promise<Next> => {
		if (outcome.kind === "answer") {
			const delivered = await tx.doc(Delivered, job.runtime.conversationId);
			const claim = delivered.answers[String(outcome.entryId)];
			if (claim !== undefined) claim.state = state.unknown === true ? "unknown" : "sent";
		}
		return terminal();
	}, job.context);
	job.deps.log.info("delivered", { chat: job.task.input.chatId, outcome: outcome.kind, chunks: state.sent });
}

/**
 * After a failed run, queued messages stay in the inbox until something places them; a passive write gives the
 * conversation that boundary. Idempotent by request id.
 */
async function unstickQueue(job: Job, outcome: Extract<Outcome, { kind: "unanswered" }>): Promise<void> {
	const id = job.runtime.conversationId;
	try {
		const inbox = await job.runtime.snapshot(InboxDoc, id, job.context);
		if ((inbox?.items.length ?? 0) === 0) return;
		await writeNote(job, id, `[previous request failed: ${outcome.reason}]`, `tg:unstick:${job.task.id}`);
	} catch (error) {
		if (job.runtime.signal.aborted) throw error;
		job.deps.log.warn("unstick_failed", { error: errorSummary(error) });
	}
}

async function writeNote(job: Job, id: ConversationId, text: string, requestId: string): Promise<void> {
	const conversation = await job.deps.harness().conversation(id, job.context);
	const message = { role: "user" as const, content: text, timestamp: job.runtime.now() };
	await conversation?.submit(
		{ type: "write", requestId, entry: { kind: UserEntry.kind, model: [message] } },
		job.context,
	);
}
