import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	configure,
	type Harness,
	type ModelRef,
} from "@earendil-works/pi-durable";
import { ChatInfo, ChatMap, ChatSettings, chatKey, type StoredSettings } from "./docs.ts";

export type AgentDefaults = {
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly cwd: string;
};

/** The model and level of a chat's stored choice, checked against the models now; undefined: use the defaults. */
export type StoredChoice = (
	settings: StoredSettings,
) => { readonly model: ModelRef; readonly thinkingLevel: ModelThinkingLevel } | undefined;

/** One durable conversation per Telegram chat/topic, created on first contact in one commit. */
export class ConversationDirectory {
	readonly #harness: Harness;
	readonly #defaults: AgentDefaults;
	readonly #chosen: StoredChoice;
	readonly #cache = new Map<string, ConversationId>();

	constructor(harness: Harness, defaults: AgentDefaults, chosen: StoredChoice = () => undefined) {
		this.#harness = harness;
		this.#defaults = defaults;
		this.#chosen = chosen;
	}

	async get(chatId: number, context: Context, threadId?: number): Promise<Conversation> {
		const key = chatKey(chatId, threadId);
		const id = this.#cache.get(key) ?? (await this.#lookupOrCreate(chatId, context, threadId));
		this.#cache.set(key, id);
		const conversation = await this.#harness.conversation(id, context);
		if (conversation === undefined) throw new Error(`Conversation ${id} of chat ${chatId} is missing`);
		return conversation;
	}

	#lookupOrCreate(chatId: number, context: Context, threadId?: number): Promise<ConversationId> {
		const defaults = this.#defaults;
		const key = chatKey(chatId, threadId);
		return this.#harness.commit(async (tx) => {
			const map = await tx.doc(ChatMap);
			const known = map.chats[key];
			if (known !== undefined) return known as ConversationId;
			const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await configure(tx, record.id, {
				model: defaults.model,
				thinkingLevel: defaults.thinkingLevel,
				cwd: defaults.cwd,
			});
			const info = await tx.doc(ChatInfo, record.id);
			info.chatId = chatId;
			if (threadId !== undefined && threadId > 0) info.threadId = threadId;
			map.chats[key] = record.id;
			return record.id;
		}, context);
	}

	/**
	 * Apply the configured working directory to existing chats, and the model and thinking level: the chat's stored
	 * choice when it is still usable, else the configured default (env changes after restart).
	 */
	async reconfigureAll(context: Context): Promise<number> {
		const map = await this.#harness.snapshot(ChatMap, context);
		let changed = 0;
		for (const id of Object.values(map?.chats ?? {})) {
			const conversation = await this.#harness.conversation(id as ConversationId, context);
			if (conversation !== undefined && (await this.#reconfigure(conversation, context))) changed += 1;
		}
		return changed;
	}

	async #reconfigure(conversation: Conversation, context: Context): Promise<boolean> {
		const agent = await conversation.agent(context);
		const settings = await this.#harness.snapshot(ChatSettings, conversation.id, context);
		const { cwd } = this.#defaults;
		const { model, thinkingLevel } = (settings === undefined ? undefined : this.#chosen(settings)) ?? this.#defaults;
		const same =
			agent.model?.provider === model.provider &&
			agent.model.modelId === model.modelId &&
			agent.thinkingLevel === thinkingLevel &&
			agent.cwd === cwd;
		if (!same) await conversation.configure({ model, thinkingLevel, cwd }, context);
		return !same;
	}
}
