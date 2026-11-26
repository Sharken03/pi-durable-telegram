import type { JsonValue } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";

/** Telegram chat id → durable conversation id; one conversation per allowed private chat. */
export const ChatMap = defineDoc<{ chats: Record<string, number> }>({
	kind: "tg.chats",
	version: 1,
	checkpointWhen: () => false,
	scope: "session",
	initial: () => ({ chats: {} }),
});

/** The Telegram chat a conversation belongs to, so tools and tasks find it from `conversationId`. */
export const ChatInfo = defineDoc<{ chatId: number }>({
	kind: "tg.chat",
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ chatId: 0 }),
});

/**
 * Ring of recently admitted Telegram message keys (`tg:<chat>:<message>:<date>`) and update markers (`u:<update>`):
 * redelivered updates are dropped. Keys of earlier versions (`tg:<chat>:<message>`) stay until they age out; no new
 * key matches them.
 */
export const Intake = defineDoc<{ keys: string[] }>({
	kind: "tg.intake",
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ keys: [] }),
});

export const INTAKE_RING_SIZE = 2000;

export type DeliveryState = "sending" | "sent" | "unknown";

/** Which answer entries were claimed for delivery, by which task: an answer is sent to Telegram once. */
export const Delivered = defineDoc<{
	answers: Record<string, { taskId: number; state: DeliveryState }>;
	order: number[];
}>({
	kind: "tg.delivered",
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ answers: {}, order: [] }),
});

export const DELIVERED_RING_SIZE = 500;

/** The exact Markdown of recently sent messages with callback buttons, by message id: a tap marks its choice there. */
export const Buttons = defineDoc<{ messages: Record<string, string>; order: number[] }>({
	kind: "tg.buttons",
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ messages: {}, order: [] }),
});

export const BUTTONS_RING_SIZE = 50;

/** Keep `markdown` as the text of `messageId`, dropping the oldest messages beyond `BUTTONS_RING_SIZE`. */
export function rememberButtons(
	doc: { messages: Record<string, string>; order: number[] },
	messageId: number,
	markdown: string,
): void {
	if (!Object.hasOwn(doc.messages, String(messageId))) doc.order.push(messageId);
	doc.messages[String(messageId)] = markdown;
	while (doc.order.length > BUTTONS_RING_SIZE) delete doc.messages[String(doc.order.shift())];
}

/**
 * `tg:<chatId>:<messageId>:<date>`: the intake key and the durable request id of the message's submission. Message ids
 * start again when the bot (its token) changes; the send date keeps a new message apart from an old one with the same
 * id, and a redelivered update carries the same date.
 */
export function messageKey(chatId: number, messageId: number, date: number): string {
	return `tg:${chatId}:${messageId}:${date}`;
}

/** `u:<updateId>`: kept next to a key, so a duplicate can be told apart as a redelivery of the same update. */
export function updateMarker(updateId: number): string {
	return `u:${updateId}`;
}

/** Add `key` to a ring, dropping the oldest beyond `size`; false when it was already present. */
export function pushRing(keys: string[], key: string, size: number): boolean {
	if (keys.includes(key)) return false;
	keys.push(key);
	if (keys.length > size) keys.splice(0, keys.length - size);
	return true;
}

/** How much of a run the chat shows: `off` only text, `on` call lines and a steps fold, `full` also arguments. */
export type Verbose = "off" | "on" | "full";
export const VERBOSE_LEVELS: readonly Verbose[] = ["off", "on", "full"];
export type ChatView = { verbose: Verbose; reasoning: boolean };
export const DEFAULT_VIEW: ChatView = { verbose: "on", reasoning: false };

/** Per-chat output settings set by /verbose and /reasoning; absent fields take `DEFAULT_VIEW`. */
export const ChatSettings = defineDoc<{ verbose?: Verbose; reasoning?: boolean }>({
	kind: "tg.settings",
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

/** The settings of a chat with the defaults filled in. */
export function viewOf(settings: { verbose?: Verbose; reasoning?: boolean } | null | undefined): ChatView {
	return {
		verbose: settings?.verbose ?? DEFAULT_VIEW.verbose,
		reasoning: settings?.reasoning ?? DEFAULT_VIEW.reasoning,
	};
}

/** A failed request, by the message id of its error message: the Retry button sends `content` again. */
export type RetryRecord = { content: JsonValue; replyTo?: number };

export const Retries = defineDoc<{ messages: Record<string, RetryRecord>; order: number[] }>({
	kind: "tg.retries",
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ messages: {}, order: [] }),
});

export const RETRIES_RING_SIZE = 20;

/** Keep the request behind error message `messageId`, dropping the oldest beyond `RETRIES_RING_SIZE`. */
export function rememberRetry(
	doc: { messages: Record<string, RetryRecord>; order: number[] },
	messageId: number,
	record: RetryRecord,
): void {
	if (!Object.hasOwn(doc.messages, String(messageId))) doc.order.push(messageId);
	doc.messages[String(messageId)] = record;
	while (doc.order.length > RETRIES_RING_SIZE) delete doc.messages[String(doc.order.shift())];
}
