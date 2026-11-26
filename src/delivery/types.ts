import type { JsonValue } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Harness, ModelRef } from "@earendil-works/pi-durable";
import type { ChatView } from "../channel/docs.ts";
import type { FatalHandler } from "../runtime/fatal.ts";
import type { Logger } from "../runtime/log.ts";
import type { TelegramPort } from "../telegram/port.ts";

export type DeliverInput = {
	chatId: number;
	/** The user's Telegram message; the answer replies to it. Absent for a wake that answers no message (a reminder). */
	messageId?: number;
	/** Durable request id of the submission: `tg:<chat>:<message>` (`remind:<id>:<due>` for a reminder). */
	requestId: string;
	/** pi-ai `UserInput`. */
	content: JsonValue;
};

export type Preview = { messageId: number };

/** `from`: the user's entry, where the run's steps start (absent in states of earlier versions). */
export type Outcome =
	| { kind: "answer"; entryId: number; from?: number }
	| { kind: "unanswered"; reason: string; detail?: string }
	| { kind: "shared"; entryId: number };

export type WaitState = { phase: "wait"; submissionId?: number; preview?: Preview };

export type SendState = {
	phase: "send";
	outcome: Outcome;
	preview?: Preview;
	/** Chunks delivered (or given up on) so far. */
	sent: number;
	/** Index of a non-idempotent send started but not recorded: after a crash chunk 0 is sent again, others skipped. */
	inFlight?: number;
	messageIds: number[];
	/** Retry counters survive durable sleeps and process restarts. */
	editAttempts?: number;
	rateLimitWaits?: number;
	previewSkipped?: boolean;
	/** Some chunk's outcome is unknown. */
	unknown?: boolean;
	/** Telegram rejected the rich message at this chunk: the rest of the answer goes out as HTML. */
	htmlFrom?: number;
	/** The chat's output settings when the run ended, so a resend renders the same chunks. */
	view?: ChatView;
	/** When the run settled (ms): the footer's time ends here. */
	endedAt?: number;
};

export type DeliverState = WaitState | SendState;

/** What delivery needs from the running channel; getters, because tasks are defined before the Harness opens. */
export type DeliveryDeps = {
	readonly port: () => TelegramPort;
	readonly harness: () => Harness;
	readonly log: Logger;
	readonly model: ModelRef;
	readonly onFatal: FatalHandler;
	/** Answers go out as rich messages and stream as native drafts. */
	readonly rich?: boolean;
	readonly previewIntervalMs?: number;
	/** Pauses between final preview edits during a Telegram outage (default `EDIT_RETRY_DELAYS_MS`). */
	readonly editRetryDelaysMs?: readonly number[];
	/** The context limit of a model (the cap or its window), for the answer's footer. */
	readonly contextLimit?: (provider: string, modelId: string) => number | undefined;
	/** The preset of a model and effort level, for the answer's footer. */
	readonly presetName?: (provider: string, modelId: string, effort: ModelThinkingLevel) => string | undefined;
};
