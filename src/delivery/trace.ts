import type { JsonValue } from "@earendil-works/chord";

/**
 * What a run did, independent of the agent backend: its tool calls and the text between them in order, its
 * reasoning, and what the footer shows. The draft and the final answer are rendered from it.
 */
export type StepStatus = "pending" | "running" | "ok" | "error";

export type Step = {
	readonly id: string;
	readonly name: string;
	args: JsonValue | undefined;
	status: StepStatus;
	/** The result text, cut to `RESULT_MAX` characters. */
	result?: string;
	/** A unified diff of the file the call changed (write, edit). */
	patch?: string;
};

export type TraceItem =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "call"; readonly step: Step };

export type Trace = {
	items: TraceItem[];
	reasoning: string[];
	/** When the user's message was placed, and when the run settled (ms). */
	startedAt?: number;
	endedAt?: number;
	/** The model that wrote the answer, and the context size after it in tokens. */
	model?: string;
	provider?: string;
	contextTokens?: number;
};

export const RESULT_MAX = 2000;
/** A larger patch is not kept: the changes fold names the file without a diff. */
export const PATCH_MAX = 64 * 1024;

export function emptyTrace(): Trace {
	return { items: [], reasoning: [] };
}

/** The calls of a trace, in order. */
export function stepsOf(trace: Trace): Step[] {
	return trace.items.flatMap((item) => (item.kind === "call" ? [item.step] : []));
}
