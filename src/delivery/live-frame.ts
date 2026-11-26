import type { JsonValue } from "@earendil-works/chord";
import type { LiveState } from "@earendil-works/pi-durable";
import { toolHint } from "./hints.ts";

/** `calling`: the current generation has tool calls, so its text is text between calls, not the answer. */
export type LiveFrame = {
	readonly mine: boolean;
	readonly text: string;
	readonly hint: string | undefined;
	readonly calling: boolean;
};

type Part = { type: string; text?: string; id?: string; name?: string; arguments?: JsonValue };

/**
 * Reads `pi.live` frames for one submission: whether its run is the current one, the current turn's streamed text,
 * and a hint for a running tool. Tool arguments are remembered from streamed tool calls, since slots lack them.
 */
export class LiveTracker {
	readonly #submissionId: number;
	readonly #args = new Map<string, JsonValue>();

	constructor(submissionId: number) {
		this.#submissionId = submissionId;
	}

	update(live: Readonly<LiveState> | null): LiveFrame {
		const mine = live?.run?.inputs.includes(this.#submissionId as never) === true;
		if (!mine || live === null) return { mine: false, text: "", hint: undefined, calling: false };
		const parts = (live.generation?.message?.content ?? []) as readonly Part[];
		for (const part of parts) {
			if (part.type === "toolCall" && part.id !== undefined) this.#args.set(part.id, part.arguments ?? null);
		}
		const text = parts.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("");
		const calling = parts.some((part) => part.type === "toolCall");
		return { mine, text, hint: this.#hint(live), calling };
	}

	/** The streamed arguments of call `callId`, if seen. */
	args(callId: string): JsonValue | undefined {
		return this.#args.get(callId);
	}

	#hint(live: Readonly<LiveState>): string | undefined {
		const running = live.tools?.find((slot) => slot.status === "running");
		return running === undefined ? undefined : toolHint(running.name, this.#args.get(running.callId));
	}
}
