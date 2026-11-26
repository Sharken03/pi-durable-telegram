import type { Context } from "@earendil-works/chord";
import type { LiveState } from "@earendil-works/pi-durable";
import type { Verbose } from "../channel/docs.ts";
import type { Logger } from "../runtime/log.ts";
import { errorSummary } from "../runtime/log.ts";
import { LiveTracker } from "./live-frame.ts";
import type { PreviewFrame } from "./preview.ts";
import { type EntryReader, readEntries, TraceBuilder } from "./run-entries.ts";
import { draftStatus } from "./run-view.ts";

export type DraftFrame = PreviewFrame & { readonly mine: boolean };

export type RunTrackerOptions = {
	readonly submissionId: number;
	readonly reader: EntryReader;
	readonly context: Context;
	readonly verbose: Verbose;
	readonly rich: boolean;
	readonly log: Logger;
};

/**
 * Turns `pi.live` frames of one submission into draft frames: the streamed answer text and, unless verbose is off
 * or the submission joined a run that was already running, the run's call lines. Finished calls come from the run's
 * entries, read on from the last one seen whenever the tool slots change; running and waiting calls come from the
 * slots.
 */
export class RunTracker {
	readonly #o: RunTrackerOptions;
	readonly #live: LiveTracker;
	readonly #builder = new TraceBuilder();
	#signature = "";

	constructor(options: RunTrackerOptions) {
		this.#o = options;
		this.#live = new LiveTracker(options.submissionId);
	}

	async update(live: Readonly<LiveState> | null): Promise<DraftFrame> {
		const frame = this.#live.update(live);
		if (!frame.mine || live === null) return { mine: false, text: "", status: "" };
		// A message that joined a running run (steering) shows no call lines: the run's first message shows them.
		const owner = Number(live.run?.inputs[0]) === this.#o.submissionId;
		if (this.#o.verbose === "off" || !owner) return { mine: true, text: frame.text, status: "" };
		await this.#refresh(live);
		const note = frame.calling && frame.text.trim() !== "" ? frame.text : undefined;
		const status = draftStatus(this.#builder.trace, note, this.#o.verbose, this.#o.rich);
		return { mine: true, text: frame.calling ? "" : frame.text, status };
	}

	async #refresh(live: Readonly<LiveState>): Promise<void> {
		const slots = live.tools ?? [];
		const calls = slots.map((slot) => `${slot.callId}:${slot.status}:${slot.entry ?? ""}`);
		const signature = `${live.run?.turns ?? 0}|${calls.join(",")}`;
		const first = live.run?.first;
		if (signature !== this.#signature && first !== undefined) {
			this.#signature = signature;
			const last = this.#builder.lastId;
			try {
				const from = last === undefined ? Number(first) : last + 1;
				await readEntries(this.#o.reader, from, undefined, this.#o.context, (entry) => this.#builder.add(entry));
			} catch (error) {
				this.#o.log.debug("draft_entries_failed", { error: errorSummary(error) });
			}
		}
		for (const slot of slots) {
			const step = this.#builder.call(slot.callId, slot.name, this.#live.args(slot.callId));
			if (step.status === "pending" || step.status === "running")
				step.status = slot.status === "running" ? "running" : "pending";
		}
	}
}
