import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { THINKING_LEVELS } from "../config/schema.ts";

/** A model and effort level for a chat; `ref` is `provider/modelId`. */
export type Choice = { readonly provider: string; readonly modelId: string; readonly effort: ModelThinkingLevel };

/** A model the panel offers, with the effort levels it supports (none for a model without thinking). */
export type ModelChoice = {
	readonly provider: string;
	readonly modelId: string;
	readonly ref: string;
	readonly efforts: readonly ModelThinkingLevel[];
};

/** A named model and effort level; each preset is also a bot command. */
export type Preset = Choice & { readonly name: string; readonly ref: string };

/** The models and presets of the model panel, in the order of the environment, and the env default. */
export type Catalog = {
	readonly models: readonly ModelChoice[];
	readonly presets: readonly Preset[];
	readonly fallback: Choice;
	/** Providers that have auth: a stored choice of another provider falls back to the default. */
	readonly authed: ReadonlySet<string>;
};

export type CatalogInput = {
	readonly fallback: Choice;
	/** `PI_MODEL_CHOICES` items. */
	readonly choices: readonly string[];
	/** `PI_PRESETS` items: `name=provider/model:level`, the level optional. */
	readonly presets: readonly string[];
	/** Command names a preset must not take. */
	readonly reserved: ReadonlySet<string>;
	readonly getModel: (provider: string, modelId: string) => Model<Api> | undefined;
	readonly hasAuth: (provider: string) => Promise<boolean>;
};

const PRESET_NAME = /^[a-z0-9_]{1,32}$/;
/** Callback data is at most 64 bytes; model buttons carry `ork:m:<ref>`. */
const DATA_MAX_BYTES = 64;
export const MODEL_DATA = "ork:m:";
export const PRESET_DATA = "ork:p:";
export const EFFORT_DATA = "ork:e:";

/** `provider/modelId`, split at the first slash (OpenRouter ids have slashes of their own). */
export function parseRef(text: string): { provider: string; modelId: string } | undefined {
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) return undefined;
	return { provider: text.slice(0, slash).trim(), modelId: text.slice(slash + 1).trim() };
}

export function refOf(choice: { provider: string; modelId: string }): string {
	return `${choice.provider}/${choice.modelId}`;
}

/** The effort levels a model supports, lowest first; none for a model without thinking. */
export function effortsOf(model: Model<Api>): ModelThinkingLevel[] {
	return model.reasoning ? getSupportedThinkingLevels(model) : [];
}

/** `level` when supported; else the nearest lower supported level, else the lowest; "off" without levels. */
export function fitEffort(level: ModelThinkingLevel, efforts: readonly ModelThinkingLevel[]): ModelThinkingLevel {
	if (efforts.length === 0) return "off";
	if (efforts.includes(level)) return level;
	const rank = (each: ModelThinkingLevel) => THINKING_LEVELS.indexOf(each);
	const sorted = [...efforts].sort((a, b) => rank(a) - rank(b));
	return sorted.findLast((each) => rank(each) < rank(level)) ?? (sorted[0] as ModelThinkingLevel);
}

/** Providers named by the default, the model choices and the presets: each is registered at start. */
export function providersOf(fallback: string, choices: readonly string[], presets: readonly string[]): string[] {
	const refs = [...choices, ...presets.map((item) => splitPreset(item)?.ref ?? "")];
	const named = refs.flatMap((ref) => parseRef(ref)?.provider ?? []);
	return [...new Set([fallback, ...named])];
}

/**
 * The model panel's models and presets, with a warning for each item left out or changed: an unknown model, a
 * provider without a key, a bad or taken preset name, or a preset level the model lacks (the nearest lower is used).
 */
export async function buildCatalog(input: CatalogInput): Promise<{ catalog: Catalog; warnings: string[] }> {
	const warnings: string[] = [];
	const authed = new Set<string>();
	const auth = async (provider: string) => {
		if (authed.has(provider)) return true;
		const ok = await input.hasAuth(provider).catch(() => false);
		if (ok) authed.add(provider);
		return ok;
	};
	await auth(input.fallback.provider);
	const models: ModelChoice[] = [];
	const fallbackRef = refOf(input.fallback);
	const refs = input.choices.includes(fallbackRef) ? input.choices : [fallbackRef, ...input.choices];
	for (const text of refs) {
		const found = await usable("PI_MODEL_CHOICES", text, input, auth, warnings);
		if (found === undefined || models.some((each) => each.ref === found.ref)) continue;
		if (!fitsButton(found.ref)) {
			warnings.push(`PI_MODEL_CHOICES: ${text} is too long for a button; use /model ${text}`);
			continue;
		}
		models.push(found);
	}
	const presets: Preset[] = [];
	for (const item of input.presets) {
		const preset = await presetOf(item, input, auth, warnings);
		if (preset === undefined) continue;
		if (presets.some((each) => each.name === preset.name)) warnings.push(`PI_PRESETS: ${preset.name} is named twice`);
		else presets.push(preset);
	}
	return { catalog: { models, presets, fallback: input.fallback, authed }, warnings };
}

async function usable(
	variable: string,
	text: string,
	input: CatalogInput,
	auth: (provider: string) => Promise<boolean>,
	warnings: string[],
): Promise<ModelChoice | undefined> {
	const ref = parseRef(text);
	const model = ref === undefined ? undefined : input.getModel(ref.provider, ref.modelId);
	if (ref === undefined || model === undefined) {
		warnings.push(`${variable}: unknown model ${JSON.stringify(text)}`);
		return undefined;
	}
	if (!(await auth(ref.provider))) {
		warnings.push(`${variable}: no key for ${ref.provider}; ${text} is left out`);
		return undefined;
	}
	return { ...ref, ref: refOf(ref), efforts: effortsOf(model) };
}

export function splitPreset(item: string): { name: string; ref: string; level?: string } | undefined {
	const equals = item.indexOf("=");
	if (equals <= 0) return undefined;
	const name = item.slice(0, equals).trim();
	const target = item.slice(equals + 1).trim();
	// The level follows the last colon; a model id may have colons of its own (":free").
	const colon = target.lastIndexOf(":");
	const level = colon < 0 ? undefined : target.slice(colon + 1).trim();
	if (level !== undefined && THINKING_LEVELS.includes(level as ModelThinkingLevel))
		return { name, ref: target.slice(0, colon).trim(), level };
	return { name, ref: target };
}

async function presetOf(
	item: string,
	input: CatalogInput,
	auth: (provider: string) => Promise<boolean>,
	warnings: string[],
): Promise<Preset | undefined> {
	const parts = splitPreset(item);
	if (parts === undefined) {
		warnings.push(`PI_PRESETS: ${JSON.stringify(item)} is not name=provider/model:level`);
		return undefined;
	}
	const { name } = parts;
	if (!PRESET_NAME.test(name)) {
		warnings.push(`PI_PRESETS: ${JSON.stringify(name)} is not a command name (a-z, 0-9, _, at most 32)`);
		return undefined;
	}
	if (input.reserved.has(name)) {
		warnings.push(`PI_PRESETS: ${name} is a command of the bot`);
		return undefined;
	}
	const model = await usable("PI_PRESETS", parts.ref, input, auth, warnings);
	if (model === undefined) return undefined;
	const wanted = (parts.level ?? input.fallback.effort) as ModelThinkingLevel;
	const effort = fitEffort(wanted, model.efforts);
	if (parts.level !== undefined && effort !== wanted)
		warnings.push(`PI_PRESETS: ${name}: ${model.modelId} has no level ${wanted}; using ${effort}`);
	return { name, ref: model.ref, provider: model.provider, modelId: model.modelId, effort };
}

/** A catalog with the default model only: for a channel opened without `PI_MODEL_CHOICES` and `PI_PRESETS`. */
export function defaultCatalog(fallback: Choice, model: Model<Api> | undefined): Catalog {
	const efforts = model === undefined ? [] : effortsOf(model);
	return {
		models: [{ provider: fallback.provider, modelId: fallback.modelId, ref: refOf(fallback), efforts }],
		presets: [],
		fallback,
		authed: new Set([fallback.provider]),
	};
}

/**
 * The model `text` names: a panel model, else any registry model of a provider with auth; undefined for an unknown
 * model or a provider without a key.
 */
export function lookupModel(
	catalog: Catalog,
	getModel: (provider: string, modelId: string) => Model<Api> | undefined,
	text: string,
): ModelChoice | undefined {
	const ref = parseRef(text);
	if (ref === undefined) return undefined;
	const listed = catalog.models.find((each) => each.ref === refOf(ref));
	if (listed !== undefined) return listed;
	const model = catalog.authed.has(ref.provider) ? getModel(ref.provider, ref.modelId) : undefined;
	return model === undefined ? undefined : { ...ref, ref: refOf(ref), efforts: effortsOf(model) };
}

/** Whether `ref` fits in a model button's callback data. */
export function fitsButton(ref: string): boolean {
	return Buffer.byteLength(MODEL_DATA + ref) <= DATA_MAX_BYTES;
}

/** The preset whose model and level are `choice`, if any. */
export function presetFor(catalog: Catalog, choice: Choice): Preset | undefined {
	return catalog.presets.find(
		(preset) =>
			preset.provider === choice.provider && preset.modelId === choice.modelId && preset.effort === choice.effort,
	);
}

/** Use-count keys: models and presets are counted apart. */
export const modelUse = (ref: string) => `m:${ref}`;
export const presetUse = (name: string) => `p:${name}`;

/** Most used first; equal counts keep the given (environment) order. */
export function sortByUse<T>(
	items: readonly T[],
	key: (item: T) => string,
	counts: Readonly<Record<string, number>>,
): T[] {
	return items
		.map((item, index) => ({ item, index, count: counts[key(item)] ?? 0 }))
		.sort((a, b) => b.count - a.count || a.index - b.index)
		.map((entry) => entry.item);
}
