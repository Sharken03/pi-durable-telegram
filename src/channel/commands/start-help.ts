import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { recordKey } from "../intake.ts";
import { type MessageScope, reply } from "../scope.ts";
import type { Preset } from "../../agent/choices.ts";
import { commandsFor } from "./list.ts";

export function helpText(voice: boolean, presets: readonly Preset[] = []): string {
	return [
		"I am a personal coding agent running on your server. Write a task and I work on it in the working directory.",
		"",
		...commandsFor(presets).map((command) => `/${command.command} - ${command.description}`),
		"",
		"/m is short for /model and /t for /think. /model provider/model and /think <level> choose directly.",
		"Photos and documents are saved to inbox/ and I can look at them. I can send files back.",
		voice ? "Voice messages are transcribed." : "Voice messages are off (no DEEPGRAM_API_KEY).",
		"Messages sent while I work are queued and answered in order.",
		"An error has Retry and Stop buttons. A long answer also comes as answer.md; a long diff has a Full diff button.",
	].join("\n");
}

/** /start and /help: record the key, then reply once. */
export async function runHelp(scope: MessageScope): Promise<void> {
	if (!(await recordKey(scope.conversation, scope.key, BG, scope.updateId))) return;
	await reply(scope, helpText(scope.rt.stt !== undefined, scope.rt.catalog.presets));
}
