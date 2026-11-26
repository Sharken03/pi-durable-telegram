import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	buildCatalog,
	type Catalog,
	fitEffort,
	lookupModel,
	providersOf,
	sortByUse,
	splitPreset,
} from "../../src/agent/choices.ts";
import { RESERVED } from "../../src/channel/commands/list.ts";
import { orderByUse, orderOfButtons, renderPanel } from "../../src/channel/model-panel.ts";

/** A registry model: `lacks` null for one without thinking; else the levels it lacks are mapped to null. */
function model(provider: string, id: string, lacks: readonly ModelThinkingLevel[] | null): Model<Api> {
	const thinkingLevelMap = Object.fromEntries((lacks ?? []).map((level) => [level, null]));
	return {
		id,
		name: id,
		provider,
		api: "faux",
		baseUrl: "",
		reasoning: lacks !== null,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1000,
		...(lacks === null ? {} : { thinkingLevelMap: { xhigh: "xhigh", max: "max", ...thinkingLevelMap } }),
	} as unknown as Model<Api>;
}

const REGISTRY = [
	model("deepseek", "deepseek-flash", ["minimal", "medium", "xhigh"]),
	model("deepseek", "deepseek-v4-pro", ["minimal", "low", "medium", "xhigh"]),
	model("deepseek", "plain", null),
	model("openrouter", "vendor/free:free", []),
	model("anthropic", "claude", []),
];

const getModel = (provider: string, id: string) => REGISTRY.find((m) => m.provider === provider && m.id === id);

function catalogOf(choices: string[], presets: string[], authed = ["deepseek", "openrouter"]) {
	return buildCatalog({
		fallback: { provider: "deepseek", modelId: "deepseek-flash", effort: "high" },
		choices,
		presets,
		reserved: RESERVED,
		getModel,
		hasAuth: async (provider) => authed.includes(provider),
	});
}

test("fitEffort: the same level, else the nearest lower, else the lowest; off without levels", () => {
	const pro: ModelThinkingLevel[] = ["off", "high", "max"];
	assert.equal(fitEffort("high", pro), "high");
	assert.equal(fitEffort("xhigh", pro), "high");
	assert.equal(fitEffort("medium", pro), "off");
	assert.equal(fitEffort("low", ["low", "high"]), "low");
	assert.equal(fitEffort("minimal", ["low", "high"]), "low", "no lower level: the lowest");
	assert.equal(fitEffort("high", []), "off");
});

test("splitPreset: the level follows the last colon only when it is a level; ids keep their own colons", () => {
	assert.deepEqual(splitPreset("fast=deepseek/deepseek-flash:low"), {
		name: "fast",
		ref: "deepseek/deepseek-flash",
		level: "low",
	});
	const free = { name: "free", ref: "openrouter/vendor/free:free" };
	assert.deepEqual(splitPreset("free=openrouter/vendor/free:free"), free);
	assert.deepEqual(splitPreset("free=openrouter/vendor/free:free:high"), {
		name: "free",
		ref: "openrouter/vendor/free:free",
		level: "high",
	});
	assert.equal(splitPreset("=deepseek/plain"), undefined);
});

test("providersOf: the default provider, then each named one once", () => {
	assert.deepEqual(providersOf("deepseek", ["anthropic/claude", "deepseek/plain"], ["x=openrouter/vendor/a:low"]), [
		"deepseek",
		"anthropic",
		"openrouter",
	]);
});

test("buildCatalog: warns for each model or preset it leaves out or changes", async () => {
	const { catalog, warnings } = await catalogOf(
		["deepseek/deepseek-v4-pro", "deepseek/nope", "anthropic/claude", "openrouter/vendor/free:free", "deepseek/plain"],
		[
			"fast=deepseek/deepseek-flash:low",
			"smart=deepseek/deepseek-v4-pro:medium",
			"Bad-Name=deepseek/plain",
			"model=deepseek/plain",
			"fast=deepseek/plain",
			"claude=anthropic/claude:high",
			"plain=deepseek/plain:high",
			"free=openrouter/vendor/free:free",
		],
	);
	assert.deepEqual(
		catalog.models.map((m) => m.ref),
		["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro", "openrouter/vendor/free:free", "deepseek/plain"],
		"the default first, then the usable choices in order",
	);
	assert.deepEqual(
		catalog.presets.map((p) => `${p.name}=${p.modelId}:${p.effort}`),
		["fast=deepseek-flash:low", "smart=deepseek-v4-pro:off", "plain=plain:off", "free=vendor/free:free:high"],
	);
	assert.deepEqual(warnings, [
		'PI_MODEL_CHOICES: unknown model "deepseek/nope"',
		"PI_MODEL_CHOICES: no key for anthropic; anthropic/claude is left out",
		"PI_PRESETS: smart: deepseek-v4-pro has no level medium; using off",
		'PI_PRESETS: "Bad-Name" is not a command name (a-z, 0-9, _, at most 32)',
		"PI_PRESETS: model is a command of the bot",
		"PI_PRESETS: fast is named twice",
		"PI_PRESETS: no key for anthropic; anthropic/claude is left out",
		"PI_PRESETS: plain: plain has no level high; using off",
	]);
	assert.deepEqual(catalog.models[0]?.efforts, ["off", "low", "high", "max"]);
	assert.deepEqual(catalog.models.at(-1)?.efforts, [], "a model without thinking has no levels");
});

test("buildCatalog: a ref too long for a button is left out of the panel with a hint", async () => {
	const long = `openrouter/${"x".repeat(60)}`;
	REGISTRY.push(model("openrouter", "x".repeat(60), []));
	const { catalog, warnings } = await catalogOf([long], []);
	REGISTRY.pop();
	assert.equal(catalog.models.length, 1);
	assert.deepEqual(warnings, [`PI_MODEL_CHOICES: ${long} is too long for a button; use /model ${long}`]);
});

test("lookupModel: panel models, and registry models of providers with a key", async () => {
	const { catalog } = await catalogOf([], []);
	assert.equal(lookupModel(catalog, getModel, "deepseek/plain")?.ref, "deepseek/plain");
	assert.equal(lookupModel(catalog, getModel, "anthropic/claude"), undefined, "no key");
	assert.equal(lookupModel(catalog, getModel, "deepseek/nope"), undefined);
	assert.equal(lookupModel(catalog, getModel, "plain"), undefined);
});

test("sortByUse: most used first; equal counts keep the given order", () => {
	const items = ["a", "b", "c", "d"];
	assert.deepEqual(sortByUse(items, (x) => x, {}), ["a", "b", "c", "d"]);
	assert.deepEqual(sortByUse(items, (x) => x, { c: 2, d: 2, b: 1 }), ["c", "d", "b", "a"]);
});

async function panelCatalog(): Promise<Catalog> {
	return (
		await catalogOf(
			["deepseek/deepseek-v4-pro", "deepseek/plain"],
			["fast=deepseek/deepseek-flash:low", "smart=deepseek/deepseek-v4-pro:high"],
		)
	).catalog;
}

test("panel order: sorted by use when it opens; an edit keeps the order of the shown buttons", async () => {
	const catalog = await panelCatalog();
	const counts = { "p:smart": 3, "m:deepseek/plain": 1 };
	const opened = orderByUse(catalog, counts);
	assert.deepEqual(opened.presets, ["smart", "fast"]);
	assert.deepEqual(opened.models, ["deepseek/plain", "deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
	const flash = catalog.models[0];
	assert.ok(flash !== undefined);
	const panel = renderPanel(catalog, opened, { ...flash, effort: "low" }, flash);
	const datas = panel.buttons.flat().map((button) => button.data);
	// More use since the panel opened does not move its buttons.
	assert.deepEqual(orderOfButtons(catalog, datas), opened);
	assert.deepEqual(orderOfButtons(catalog, ["ork:p:fast", "ork:m:deepseek/plain"]), {
		presets: ["fast", "smart"],
		models: ["deepseek/plain", "deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"],
	});
	assert.equal(orderOfButtons(catalog, ["x"]), undefined);
});

test("panel: presets, models, and only the levels the active model supports, the active ones marked", async () => {
	const catalog = await panelCatalog();
	const [flash, pro, plain] = catalog.models;
	assert.ok(flash !== undefined && pro !== undefined && plain !== undefined);
	const order = orderByUse(catalog, {});
	const panel = renderPanel(catalog, order, { ...flash, effort: "low" }, flash);
	assert.equal(panel.text, "Model: deepseek-flash · low (fast)");
	assert.deepEqual(
		panel.buttons.map((row) => row.map((button) => button.text)),
		[["✅ fast", "smart"], ["✅ deepseek-flash"], ["deepseek-v4-pro"], ["plain"], ["off", "✅ low", "high", "max"]],
	);
	const pros = renderPanel(catalog, order, { ...pro, effort: "high" }, pro);
	assert.equal(pros.text, "Model: deepseek-v4-pro · high (smart)");
	assert.deepEqual(pros.buttons.at(-1)?.map((button) => button.data), ["ork:e:off", "ork:e:high", "ork:e:max"]);
	const none = renderPanel(catalog, order, { ...plain, effort: "off" }, plain);
	assert.equal(none.text, "Model: plain\nEffort: not supported");
	assert.equal(none.buttons.flat().filter((button) => button.data.startsWith("ork:e:")).length, 0, "no effort row");
});
