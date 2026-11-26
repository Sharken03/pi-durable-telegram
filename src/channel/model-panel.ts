import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type Catalog,
	type Choice,
	EFFORT_DATA,
	fitsButton,
	MODEL_DATA,
	type ModelChoice,
	modelUse,
	PRESET_DATA,
	type Preset,
	presetFor,
	presetUse,
	refOf,
	sortByUse,
} from "../agent/choices.ts";
import type { InlineButton } from "../telegram/port.ts";

const PRESETS_PER_ROW = 3;
const EFFORTS_PER_ROW = 4;
const ACTIVE = "✅ ";

/** The order of the panel's preset and model buttons, by preset name and model ref. */
export type PanelOrder = { readonly presets: readonly string[]; readonly models: readonly string[] };

export type Panel = { readonly text: string; readonly buttons: InlineButton[][] };

/** The order when a panel opens: most used first, equal counts in the order of the environment. */
export function orderByUse(catalog: Catalog, counts: Readonly<Record<string, number>>): PanelOrder {
	return {
		presets: sortByUse(catalog.presets, (preset) => presetUse(preset.name), counts).map((preset) => preset.name),
		models: sortByUse(catalog.models, (model) => modelUse(model.ref), counts).map((model) => model.ref),
	};
}

/**
 * The order of a shown panel, read from its buttons, so an edit keeps the buttons where they were. Catalog items the
 * panel lacks go last; undefined when it has no panel buttons.
 */
export function orderOfButtons(catalog: Catalog, datas: readonly string[]): PanelOrder | undefined {
	const of = (prefix: string) => datas.flatMap((data) => (data.startsWith(prefix) ? [data.slice(prefix.length)] : []));
	const shown = { presets: of(PRESET_DATA), models: of(MODEL_DATA) };
	if (shown.presets.length === 0 && shown.models.length === 0) return undefined;
	const keep = (seen: readonly string[], all: readonly string[]) => [
		...seen.filter((each) => all.includes(each)),
		...all.filter((each) => !seen.includes(each)),
	];
	return {
		presets: keep(
			shown.presets,
			catalog.presets.map((preset) => preset.name),
		),
		models: keep(
			shown.models,
			catalog.models.map((model) => model.ref),
		),
	};
}

/**
 * The model panel: one line with the active model, effort and preset, then the preset buttons, one model per row,
 * and the effort levels of the active model (none for a model without thinking). The active choices have a ✅.
 */
export function renderPanel(catalog: Catalog, order: PanelOrder, active: Choice, model: ModelChoice): Panel {
	const preset = presetFor(catalog, active);
	const thinking = model.efforts.length > 0;
	const text = choiceText(catalog, active, model);
	const presets = order.presets.flatMap((name) => catalog.presets.find((each) => each.name === name) ?? []);
	const models = order.models.flatMap((ref) => catalog.models.find((each) => each.ref === ref) ?? []);
	// A model chosen by text that the panel does not list is shown too, when it fits in a button.
	if (!models.some((each) => each.ref === model.ref) && fitsButton(model.ref)) models.push(model);
	const buttons: InlineButton[][] = [
		...rows(
			presets.map((each) => presetButton(each, preset)),
			PRESETS_PER_ROW,
		),
		...models.map((each) => [modelButton(each, models, active)]),
		...(thinking
			? rows(
					model.efforts.map((level) => effortButton(level, active.effort)),
					EFFORTS_PER_ROW,
				)
			: []),
	];
	return { text, buttons };
}

/** `Model: <id> · <effort> (<preset>)`; a model without thinking gets the line `Effort: not supported` instead. */
export function choiceText(catalog: Catalog, active: Choice, model: ModelChoice): string {
	const preset = presetFor(catalog, active);
	const named = preset === undefined ? "" : ` (${preset.name})`;
	return model.efforts.length > 0
		? `Model: ${active.modelId} · ${active.effort}${named}`
		: `Model: ${active.modelId}${named}\nEffort: not supported`;
}

function presetButton(preset: Preset, active: Preset | undefined): InlineButton {
	const mark = preset.name === active?.name ? ACTIVE : "";
	return { text: `${mark}${preset.name}`, data: PRESET_DATA + preset.name };
}

/** A model's label is its id; the full ref when two listed models share the id. */
function modelButton(model: ModelChoice, all: readonly ModelChoice[], active: Choice): InlineButton {
	const shared = all.filter((each) => each.modelId === model.modelId).length > 1;
	const mark = model.ref === refOf(active) ? ACTIVE : "";
	return { text: `${mark}${shared ? model.ref : model.modelId}`, data: MODEL_DATA + model.ref };
}

function effortButton(level: ModelThinkingLevel, active: ModelThinkingLevel): InlineButton {
	return { text: `${level === active ? ACTIVE : ""}${level}`, data: EFFORT_DATA + level };
}

function rows<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
	return out;
}

/** The callback data of an inline keyboard (`reply_markup` of a tapped message), in order. */
export function buttonDatas(markup: unknown): string[] {
	const keyboard = (markup as { inline_keyboard?: unknown } | undefined)?.inline_keyboard;
	if (!Array.isArray(keyboard)) return [];
	return keyboard.flatMap((row: unknown) =>
		Array.isArray(row)
			? row.flatMap((button: { callback_data?: unknown }) =>
					typeof button?.callback_data === "string" ? [button.callback_data] : [],
				)
			: [],
	);
}
