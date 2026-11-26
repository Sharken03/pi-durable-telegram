import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type Conversation, configure } from "@earendil-works/pi-durable";
import {
	type Choice,
	EFFORT_DATA,
	effortsOf,
	fitEffort,
	lookupModel,
	MODEL_DATA,
	type ModelChoice,
	modelUse,
	PRESET_DATA,
	type Preset,
	parseRef,
	presetUse,
	refOf,
} from "../../agent/choices.ts";
import { TelegramApiError, telegramErrorSummary } from "../../telegram/errors.ts";
import { ChatSettings, ModelUse } from "../docs.ts";
import { recordKey } from "../intake.ts";
import { buttonDatas, choiceText, orderByUse, orderOfButtons, renderPanel } from "../model-panel.ts";
import { type ChannelRuntime, type MessageScope, reply } from "../scope.ts";
import { commandsFor } from "./list.ts";

/** The chat's model and effort level now, and what the registry knows of the model. */
type Active = { readonly choice: Choice; readonly model: ModelChoice };

/** /model (/m): the panel; `/model <preset>` or `/model provider/model` chooses directly. */
export async function runModel(scope: MessageScope, args: string): Promise<void> {
	if (!(await recordKey(scope.conversation, scope.key, BG, scope.updateId))) return;
	const wanted = args.trim();
	if (wanted === "") return sendPanel(scope);
	const { rt } = scope;
	const preset = rt.catalog.presets.find((each) => each.name === wanted.toLowerCase());
	if (preset !== undefined) return choosePreset(scope, preset);
	const model = lookupModel(rt.catalog, getModel(rt), wanted);
	if (model === undefined) {
		const ref = parseRef(wanted);
		const shown = JSON.stringify(wanted.slice(0, 60));
		const known = ref !== undefined && getModel(rt)(ref.provider, ref.modelId) !== undefined;
		await reply(
			scope,
			known
				? `No key for ${ref?.provider}: ${shown} cannot be used.`
				: `Unknown model ${shown}. Use /model to pick one, or /model provider/model.`,
		);
		return;
	}
	const active = await activeOf(rt, scope.conversation);
	const effort = fitEffort(active.choice.effort, model.efforts);
	const choice = { provider: model.provider, modelId: model.modelId, effort };
	await apply(rt, scope.conversation, choice, modelUse(model.ref));
	await reply(scope, `${choiceText(rt.catalog, choice, model)}.`);
}

/** /think (/t): the panel; `/think <level>` sets a level the active model supports. */
export async function runThink(scope: MessageScope, args: string): Promise<void> {
	if (!(await recordKey(scope.conversation, scope.key, BG, scope.updateId))) return;
	const wanted = args.trim().toLowerCase();
	if (wanted === "") return sendPanel(scope);
	const { rt } = scope;
	const active = await activeOf(rt, scope.conversation);
	const { efforts, modelId } = active.model;
	if (efforts.length === 0) {
		await reply(scope, `${modelId} has no effort levels.`);
		return;
	}
	if (!efforts.includes(wanted as ModelThinkingLevel)) {
		const shown = JSON.stringify(wanted.slice(0, 20));
		await reply(scope, `Effort ${shown} is not supported by ${modelId}. Use one of: ${efforts.join(", ")}.`);
		return;
	}
	const choice = { ...active.choice, effort: wanted as ModelThinkingLevel };
	await apply(rt, scope.conversation, choice);
	await reply(scope, `${choiceText(rt.catalog, choice, active.model)}.`);
}

/** A preset's own command, such as /fast. */
export async function runPreset(scope: MessageScope, preset: Preset): Promise<void> {
	if (!(await recordKey(scope.conversation, scope.key, BG, scope.updateId))) return;
	await choosePreset(scope, preset);
}

async function choosePreset(scope: MessageScope, preset: Preset): Promise<void> {
	const { rt } = scope;
	await apply(rt, scope.conversation, preset, presetUse(preset.name));
	await reply(scope, `${choiceText(rt.catalog, preset, modelOf(rt, preset))}.`);
}

/** The panel as a new message: buttons sorted by use. */
async function sendPanel(scope: MessageScope): Promise<void> {
	const { rt } = scope;
	const counts = (await rt.harness.snapshot(ModelUse, BG))?.counts ?? {};
	const active = await activeOf(rt, scope.conversation);
	const panel = renderPanel(rt.catalog, orderByUse(rt.catalog, counts), active.choice, active.model);
	try {
		await rt.port.sendMessage(scope.chatId, panel.text, {
			replyTo: scope.messageId,
			silent: true,
			buttons: panel.buttons,
		});
	} catch (error) {
		rt.log.warn("panel_send_failed", { chat: scope.chatId, ...telegramErrorSummary(error) });
	}
}

export type PanelTap = {
	readonly chatId: number;
	readonly messageId: number;
	readonly queryId: string;
	readonly data: string;
	/** `reply_markup` of the tapped message: the edit keeps its button order. */
	readonly markup: unknown;
};

/** Whether `data` is a model panel button. */
export function isPanelData(data: string): boolean {
	return [PRESET_DATA, MODEL_DATA, EFFORT_DATA].some((prefix) => data.startsWith(prefix));
}

/**
 * A tap on the panel: choose the preset, model (the level becomes the nearest the model supports) or level (only one
 * the active model supports; a stale level is refused), once per callback query. Then the same message shows the new
 * state, with its buttons in the same order.
 */
export async function handlePanelTap(rt: ChannelRuntime, conversation: Conversation, tap: PanelTap): Promise<void> {
	const fields = { chat: tap.chatId, message: tap.messageId };
	if (!(await recordKey(conversation, `tg:${tap.chatId}:cq:${tap.queryId}`, BG))) return;
	const active = await activeOf(rt, conversation);
	const next = await tapChoice(rt, active, tap.data);
	if (next === undefined) rt.log.info("panel_tap_refused", { ...fields, data: tap.data.slice(0, 64) });
	else await apply(rt, conversation, next.choice, next.use);
	const shown = next === undefined ? active : { choice: next.choice, model: modelOf(rt, next.choice) };
	const order =
		orderOfButtons(rt.catalog, buttonDatas(tap.markup)) ??
		orderByUse(rt.catalog, (await rt.harness.snapshot(ModelUse, BG))?.counts ?? {});
	const panel = renderPanel(rt.catalog, order, shown.choice, shown.model);
	try {
		await rt.port.editMessageText(tap.chatId, tap.messageId, panel.text, { buttons: panel.buttons });
	} catch (error) {
		// A tap on the active choice changes nothing; Telegram refuses an edit that keeps the message as it is.
		if (error instanceof TelegramApiError && /not modified/i.test(error.description)) return;
		rt.log.warn("panel_edit_failed", { ...fields, ...telegramErrorSummary(error) });
	}
}

async function tapChoice(
	rt: ChannelRuntime,
	active: Active,
	data: string,
): Promise<{ choice: Choice; use?: string } | undefined> {
	if (data.startsWith(PRESET_DATA)) {
		const preset = rt.catalog.presets.find((each) => each.name === data.slice(PRESET_DATA.length));
		return preset === undefined ? undefined : { choice: preset, use: presetUse(preset.name) };
	}
	if (data.startsWith(MODEL_DATA)) {
		const model = lookupModel(rt.catalog, getModel(rt), data.slice(MODEL_DATA.length));
		if (model === undefined) return undefined;
		const effort = fitEffort(active.choice.effort, model.efforts);
		return { choice: { provider: model.provider, modelId: model.modelId, effort }, use: modelUse(model.ref) };
	}
	// An effort tap from an older panel may name a level the active model lacks.
	const level = data.slice(EFFORT_DATA.length) as ModelThinkingLevel;
	return active.model.efforts.includes(level) ? { choice: { ...active.choice, effort: level } } : undefined;
}

/**
 * Configure the chat's agent and store the choice in one commit, with a use count for a chosen model or preset; the
 * switch applies from the next model request, also within a run. Then the menu follows the new preset order.
 */
async function apply(rt: ChannelRuntime, conversation: Conversation, choice: Choice, use?: string): Promise<void> {
	await conversation.commit(async (tx) => {
		const model = { provider: choice.provider, modelId: choice.modelId };
		await configure(tx, conversation.id, { model, thinkingLevel: choice.effort });
		const settings = await tx.doc(ChatSettings, conversation.id);
		settings.model = refOf(choice);
		settings.effort = choice.effort;
		if (use === undefined) return;
		const counts = (await tx.doc(ModelUse)).counts;
		counts[use] = (counts[use] ?? 0) + 1;
	}, BG);
	rt.log.info("model_chosen", { conversation: conversation.id, model: refOf(choice), effort: choice.effort });
	if (use !== undefined) await updateMenu(rt);
}

/**
 * Set the command menu with the presets in their order of use. Telegram is called only when the order differs from
 * the menu set before (`force` at start); a failed call is retried at the next choice.
 */
export async function updateMenu(rt: ChannelRuntime, force = false): Promise<void> {
	const counts = (await rt.harness.snapshot(ModelUse, BG))?.counts ?? {};
	const order = orderByUse(rt.catalog, counts).presets;
	if (!force && rt.menu.presets !== undefined && order.join("\n") === rt.menu.presets.join("\n")) return;
	const presets = order.flatMap((name) => rt.catalog.presets.find((each) => each.name === name) ?? []);
	try {
		await rt.port.setMyCommands(commandsFor(presets));
		rt.menu.presets = order;
	} catch (error) {
		rt.log.warn("set_commands_failed", telegramErrorSummary(error));
	}
}

async function activeOf(rt: ChannelRuntime, conversation: Conversation): Promise<Active> {
	const agent = await conversation.agent(BG);
	const ref = agent.model ?? rt.model;
	const choice = { provider: ref.provider, modelId: ref.modelId, effort: agent.thinkingLevel };
	return { choice, model: modelOf(rt, choice) };
}

/** What the panel or the registry knows of a model; no effort levels for a model the registry lacks. */
function modelOf(rt: ChannelRuntime, ref: { provider: string; modelId: string }): ModelChoice {
	const listed = rt.catalog.models.find((each) => each.ref === refOf(ref));
	if (listed !== undefined) return listed;
	const model = getModel(rt)(ref.provider, ref.modelId);
	const efforts = model === undefined ? [] : effortsOf(model);
	return { provider: ref.provider, modelId: ref.modelId, ref: refOf(ref), efforts };
}

function getModel(rt: ChannelRuntime) {
	return (provider: string, modelId: string) => rt.models?.getModel(provider, modelId);
}
