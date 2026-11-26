import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type FauxProviderHandle, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { ChatMap } from "../../src/channel/docs.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram, markupOf } from "../helpers/fake-telegram.ts";
import { gate, gated, textOf, toolCall } from "../helpers/faux-steps.ts";
import { callbackUpdate, textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** faux-1 has no thinking; faux-think supports off, low and high; faux-low off and low. */
function models(): FauxProviderHandle {
	const faux = newFaux({
		models: [{ id: "faux-1" }, { id: "faux-think", reasoning: true }, { id: "faux-low", reasoning: true }],
	});
	const [, think, low] = faux.models;
	if (think !== undefined) think.thinkingLevelMap = { minimal: null, medium: null };
	if (low !== undefined) low.thinkingLevelMap = { minimal: null, medium: null, high: null };
	return faux;
}

const PANEL = {
	PI_MODEL_CHOICES: "faux/faux-think,faux/faux-low",
	PI_PRESETS: "fast=faux/faux-think:low,deep=faux/faux-think:high",
};

async function setup(
	faux: FauxProviderHandle,
	config: Record<string, string> = PANEL,
	dir?: string,
): Promise<{ t: TestAgent; port: FakeTelegram; dir: string }> {
	let root = dir;
	if (root === undefined) {
		const temp = await tempDir();
		cleanups.push(temp.cleanup);
		root = temp.dir;
	}
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir: root, faux, port, config });
	cleanups.push(() => t.close());
	return { t, port, dir: root };
}

function replyTo(port: FakeTelegram, messageId: number) {
	return port.created(CHAT).find((m) => m.replyTo === messageId);
}

async function send(t: TestAgent, port: FakeTelegram, messageId: number, text: string) {
	await t.agent.channel.handleUpdate(textUpdate(CHAT, messageId, text));
	return waitFor(() => replyTo(port, messageId), { what: `reply to ${text}` });
}

/** Tap `data` on message `panelId`; Telegram sends the message's buttons along. */
async function tap(t: TestAgent, port: FakeTelegram, panelId: number, data: string) {
	const markup = markupOf(port.messages.get(panelId));
	await t.agent.channel.handleUpdate(callbackUpdate(CHAT, panelId, data, { markup }));
	return port.messages.get(panelId);
}

function labels(message: { buttons?: readonly (readonly { text: string }[])[] } | undefined): string[][] {
	return (message?.buttons ?? []).map((row) => row.map((button) => button.text));
}

async function agentOf(t: TestAgent) {
	const id = await waitFor(async () => (await t.agent.harness.snapshot(ChatMap, BG))?.chats[String(CHAT)]);
	const conversation = await t.agent.harness.conversation(id as never, BG);
	assert.ok(conversation !== undefined);
	const agent = await conversation.agent(BG);
	return `${agent.model?.modelId} · ${agent.thinkingLevel}`;
}

test("T-panel: /model, /m, /think and /t show the same panel; the aliases are not in the menu", async () => {
	const { t, port } = await setup(models());
	const expected = [["fast", "deep"], ["✅ faux-1"], ["faux-think"], ["faux-low"]];
	for (const [id, command] of ["/model", "/m", "/think", "/t"].entries()) {
		const panel = await send(t, port, id + 1, command);
		assert.equal(panel.text, "Model: faux-1\nEffort: not supported", command);
		assert.deepEqual(labels(panel), expected, `${command}: no effort row for a model without thinking`);
		assert.equal(panel.silent, true);
	}
	const menu = port.commands.map((c) => c.command);
	const expectedMenu = ["new", "stop", "compact", "status", "model", "think", "fast", "deep", "verbose", "reasoning"];
	assert.deepEqual(menu, [...expectedMenu, "help"]);
});

test("T-panel-tap: taps edit the panel; a model tap rebuilds the effort row; a stale level is refused", async () => {
	const { t, port } = await setup(models());
	const panel = await send(t, port, 1, "/model");
	const count = port.created(CHAT).length;

	let shown = await tap(t, port, panel.id, "ork:m:faux/faux-think");
	assert.equal(shown?.text, "Model: faux-think · off");
	const rows = [["fast", "deep"], ["faux-1"], ["✅ faux-think"], ["faux-low"], ["✅ off", "low", "high"]];
	assert.deepEqual(labels(shown), rows);

	shown = await tap(t, port, panel.id, "ork:e:high");
	assert.equal(shown?.text, "Model: faux-think · high (deep)");
	assert.deepEqual(labels(shown)[0], ["fast", "✅ deep"], "the preset of the choice is marked");

	shown = await tap(t, port, panel.id, "ork:m:faux/faux-low");
	assert.equal(shown?.text, "Model: faux-low · low", "high is not supported: the nearest lower level");
	assert.deepEqual(labels(shown).at(-1), ["off", "✅ low"]);
	assert.equal(await agentOf(t), "faux-low · low");

	const stale = markupOf(shown);
	shown = await tap(t, port, panel.id, "ork:m:faux/faux-1");
	assert.equal(shown?.text, "Model: faux-1\nEffort: not supported");
	assert.equal(await agentOf(t), "faux-1 · off");
	// An effort button of an older panel names a level the active model lacks.
	await t.agent.channel.handleUpdate(callbackUpdate(CHAT, panel.id, "ork:e:low", { markup: stale }));
	assert.equal(await agentOf(t), "faux-1 · off", "the stale level is refused");
	assert.equal(port.messages.get(panel.id)?.text, "Model: faux-1\nEffort: not supported");
	assert.ok(t.logs.some((line) => line.includes("panel_tap_refused")));

	assert.equal(port.created(CHAT).length, count, "no new message");
});

test("T-think-text: /t sets a supported level and names the valid ones otherwise; /m takes a ref", async () => {
	const { t, port } = await setup(models());
	assert.equal((await send(t, port, 1, "/t low")).text, "faux-1 has no effort levels.");
	assert.equal((await send(t, port, 2, "/m faux/faux-think")).text, "Model: faux-think · off.");
	assert.equal(
		(await send(t, port, 3, "/t medium")).text,
		'Effort "medium" is not supported by faux-think. Use one of: off, low, high.',
	);
	assert.equal((await send(t, port, 4, "/think low")).text, "Model: faux-think · low (fast).");
	assert.equal(await agentOf(t), "faux-think · low");
	assert.match((await send(t, port, 5, "/m faux/none")).text, /^Unknown model "faux\/none"\. Use \/model/);
	assert.equal((await send(t, port, 6, "/model deep")).text, "Model: faux-think · high (deep).");
	assert.equal(await agentOf(t), "faux-think · high");
});

test("T-panel-sort: the panel and the menu list the most used first; an edit keeps the order", async () => {
	const { t, port } = await setup(models());
	assert.equal(port.count("setMyCommands"), 1);
	assert.equal((await send(t, port, 1, "/deep")).text, "Model: faux-think · high (deep).");
	const presets = () => port.commands.map((c) => c.command).filter((name) => name === "fast" || name === "deep");
	assert.deepEqual(presets(), ["deep", "fast"]);
	assert.equal(port.count("setMyCommands"), 2);
	await send(t, port, 2, "/deep");
	assert.equal(port.count("setMyCommands"), 2, "the same order: the menu is not set again");

	await send(t, port, 3, "/m faux/faux-low");
	const panel = await send(t, port, 4, "/model");
	assert.deepEqual(labels(panel).slice(0, 4), [["deep", "fast"], ["✅ faux-low"], ["faux-1"], ["faux-think"]]);
	for (let n = 0; n < 3; n++) await tap(t, port, panel.id, "ork:p:fast");
	const edited = port.messages.get(panel.id);
	assert.deepEqual(labels(edited).slice(0, 4), [["deep", "✅ fast"], ["faux-low"], ["faux-1"], ["✅ faux-think"]]);
	assert.deepEqual(presets(), ["fast", "deep"], "the menu follows the use");
	assert.equal(port.count("setMyCommands"), 3);

	const reopened = await send(t, port, 5, "/m");
	assert.deepEqual(labels(reopened)[0], ["✅ fast", "deep"], "a new panel is sorted again");
});

test("T-choice-kept: the choice survives a restart; footer and /status name it; a gone model falls back", async () => {
	const faux = models();
	faux.setResponses([fauxAssistantMessage("hi")]);
	const rich = { ...PANEL, TELEGRAM_RICH: "auto" };
	const first = await setup(faux, rich);
	await send(first.t, first.port, 1, "/deep");
	const answer = await send(first.t, first.port, 2, "hello");
	assert.match(answer.text, /\n\n_faux-think · high \(deep\) · \d+% · \d+s_$/, "footer: model, effort and preset");
	const status = await send(first.t, first.port, 3, "/status");
	assert.match(status.text, /Model: faux\/faux-think, thinking high, preset deep/);
	await first.t.close();
	cleanups.pop();

	const second = await setup(faux, rich, first.dir);
	assert.equal(await agentOf(second.t), "faux-think · high", "the stored choice wins over PI_MODEL");
	await second.t.close();
	cleanups.pop();

	// faux-think is gone from the registry: the chat gets the configured default again.
	const third = await setup(newFaux(), {}, first.dir);
	assert.equal(await agentOf(third.t), "faux-1 · off");
	assert.ok(third.t.logs.some((line) => line.includes("stored_model_unusable")));
});

test("T-presets-checked: a preset level the model lacks becomes the nearest lower; bad names are skipped", async () => {
	const config = {
		PI_PRESETS: "mid=faux/faux-think:medium,help=faux/faux-1,Bad=faux/faux-1,x=faux/none",
	};
	const { t, port } = await setup(models(), config);
	const warnings = t.logs.filter((line) => line.includes("model_choice_skipped")).join("\n");
	assert.match(warnings, /mid: faux-think has no level medium; using low/);
	assert.match(warnings, /help is a command of the bot/);
	assert.match(warnings, /\\"Bad\\" is not a command name/);
	assert.match(warnings, /unknown model \\"faux\/none\\"/);
	assert.deepEqual(
		port.commands.map((c) => c.command).filter((name) => !["new", "stop", "compact", "status"].includes(name)),
		["model", "think", "mid", "verbose", "reasoning", "help"],
	);
	assert.equal((await send(t, port, 1, "/mid")).text, "Model: faux-think · low (mid).");
});

test("T-switch-mid-run: a choice made while a run works applies from its next model request", async () => {
	const faux = models();
	const open = gate();
	const requested: string[] = [];
	faux.setResponses([
		gated(open.promise, () => toolCall("read", { path: "missing.txt" })),
		(_context, _options, _state, model) => {
			requested.push(model.id);
			return fauxAssistantMessage("done");
		},
	]);
	const { t, port } = await setup(faux, { ...PANEL, TELEGRAM_RICH: "auto" });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "go"));
	await waitFor(() => faux.state.callCount >= 1 || undefined, { what: "first request" });
	assert.equal((await send(t, port, 2, "/fast")).text, "Model: faux-think · low (fast).");
	open.open();
	const answer = await waitFor(() => port.created(CHAT).find((m) => m.replyTo === 1 && m.text.startsWith("done")));
	assert.deepEqual(requested, ["faux-think"], "the request after the tool call used the new model");
	assert.match(answer.text, /_faux-think · low \(fast\) · /);
});

type Seen = { readonly model: string | null | undefined; readonly system: string; readonly user: string };

/** What a request tells the model: the newest model section, all system messages, and the last user text. */
function seenOf(messages: readonly Message[]): Seen {
	const system = messages.flatMap((m) => (m.role === "system" ? [m] : []));
	const sections = Object.assign({}, ...system.map((m) => m.sections ?? {})) as Record<string, string | null>;
	const shown = system.map((m) => ({ content: m.content, sections: m.sections }));
	const user = textOf(messages.findLast((m) => m.role === "user"));
	return { model: sections.model, system: JSON.stringify(shown), user };
}

test("T-model-known: the system prompt names the model, also after a switch; effort and preset are in the stamp", async () => {
	const faux = models();
	const seen: Seen[] = [];
	const answer = (text: string) => (context: { messages: Message[] }) => {
		seen.push(seenOf(context.messages));
		return fauxAssistantMessage(text);
	};
	faux.setResponses([answer("one"), answer("two"), answer("three")]);
	const { t, port } = await setup(faux);
	await send(t, port, 1, "hello");
	await send(t, port, 2, "/fast");
	await send(t, port, 3, "which model");
	await send(t, port, 4, "/t high");
	await send(t, port, 5, "and now");
	assert.equal(seen[0]?.model, "<model>\nYou run on faux/faux-1. This line is current and correct: when the user asks which model you are, name this model.\n</model>");
	assert.equal(seen[1]?.model, "<model>\nYou run on faux/faux-think. This line is current and correct: when the user asks which model you are, name this model.\n</model>", "the new model after a switch");
	assert.notEqual(seen[1]?.system, seen[0]?.system);
	assert.equal(seen[2]?.system, seen[1]?.system, "an effort switch leaves the system prompt as it was");
	assert.match(seen[0]?.user ?? "", /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]·]*\]\nhello$/, "faux-1: no effort, no preset");
	assert.match(seen[1]?.user ?? "", / · effort low · preset fast\]\nwhich model$/);
	assert.match(seen[2]?.user ?? "", / · effort high · preset deep\]\nand now$/);
});
