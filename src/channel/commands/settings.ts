import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { ChatSettings, VERBOSE_LEVELS, type Verbose, viewOf } from "../docs.ts";
import { recordKey } from "../intake.ts";
import { type MessageScope, reply } from "../scope.ts";

const VERBOSE_HELP = "off: answer only; on: tool calls in the draft and a steps fold; full: also arguments and results";

/** /verbose [off|on|full]: set how much of a run this chat shows, or show the current level. */
export async function runVerbose(scope: MessageScope, args: string): Promise<void> {
	if (!(await recordKey(scope.conversation, scope.key, BG, scope.updateId))) return;
	const wanted = args.trim().toLowerCase();
	if (wanted === "") {
		const current = viewOf(await stored(scope)).verbose;
		await reply(scope, `Verbose: ${current}. Use /verbose off|on|full (${VERBOSE_HELP}).`);
		return;
	}
	if (!VERBOSE_LEVELS.includes(wanted as Verbose)) {
		await reply(scope, `Unknown level "${wanted.slice(0, 20)}". Use /verbose off|on|full.`);
		return;
	}
	await save(scope, (doc) => {
		doc.verbose = wanted as Verbose;
	});
	await reply(scope, `Verbose: ${wanted}.`);
}

/** /reasoning [show|hide]: show the model's reasoning in a fold above each answer, or hide it (the default). */
export async function runReasoning(scope: MessageScope, args: string): Promise<void> {
	if (!(await recordKey(scope.conversation, scope.key, BG, scope.updateId))) return;
	const wanted = args.trim().toLowerCase();
	if (wanted === "") {
		const shown = viewOf(await stored(scope)).reasoning;
		await reply(scope, `Reasoning: ${shown ? "show" : "hide"}. Use /reasoning show|hide.`);
		return;
	}
	if (wanted !== "show" && wanted !== "hide") {
		await reply(scope, `Unknown value "${wanted.slice(0, 20)}". Use /reasoning show|hide.`);
		return;
	}
	await save(scope, (doc) => {
		doc.reasoning = wanted === "show";
	});
	await reply(scope, `Reasoning: ${wanted}.`);
}

function stored(scope: MessageScope) {
	return scope.rt.harness.snapshot(ChatSettings, scope.conversation.id, BG);
}

async function save(scope: MessageScope, change: (doc: { verbose?: Verbose; reasoning?: boolean }) => void) {
	await scope.conversation.commit(async (tx) => change(await tx.doc(ChatSettings, scope.conversation.id)), BG);
}
