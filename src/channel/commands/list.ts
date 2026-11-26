import type { Preset } from "../../agent/choices.ts";
import type { BotCommandSpec } from "../../telegram/port.ts";

const BEFORE_PRESETS: readonly BotCommandSpec[] = [
	{ command: "new", description: "Start a fresh context (history is kept)" },
	{ command: "stop", description: "Stop the current run; queued messages continue" },
	{ command: "compact", description: "Compact the context, optionally with instructions" },
	{ command: "status", description: "Model, context, spend and queue" },
	{ command: "model", description: "Choose the model, a preset or the effort level" },
	{ command: "think", description: "Choose the effort level of the model" },
];

const AFTER_PRESETS: readonly BotCommandSpec[] = [
	{ command: "verbose", description: "Show tool calls: off, on or full" },
	{ command: "reasoning", description: "Show or hide the model's reasoning" },
	{ command: "help", description: "What this bot does" },
];

/** The menu without presets. */
export const COMMANDS: readonly BotCommandSpec[] = [...BEFORE_PRESETS, ...AFTER_PRESETS];

/** Short forms of /model and /think: they work, but the menu does not list them. */
export const ALIASES: Readonly<Record<string, string>> = { m: "model", t: "think" };

/** Command names a preset must not take. */
export const RESERVED: ReadonlySet<string> = new Set([
	"start",
	...COMMANDS.map((command) => command.command),
	...Object.keys(ALIASES),
]);

/** The command menu: each preset after /think, in the given order. */
export function commandsFor(presets: readonly Preset[]): BotCommandSpec[] {
	const named = presets.map((preset) => ({ command: preset.name, description: presetDescription(preset) }));
	return [...BEFORE_PRESETS, ...named, ...AFTER_PRESETS];
}

export function presetDescription(preset: Preset): string {
	return preset.effort === "off" ? `Use ${preset.modelId}` : `Use ${preset.modelId} · ${preset.effort}`;
}
