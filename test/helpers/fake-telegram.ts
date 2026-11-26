import { readFile } from "node:fs/promises";
import { TelegramApiError } from "../../src/telegram/errors.ts";
import type {
	BotCommandSpec,
	ChatAction,
	DocumentOptions,
	InlineButton,
	SendOptions,
	TelegramPort,
} from "../../src/telegram/port.ts";

export type FakeMessage = {
	id: number;
	chatId: number;
	text: string;
	html: boolean;
	rich?: boolean;
	replyTo?: number;
	kind: "text" | "photo" | "document" | "animation";
	path?: string;
	caption?: string;
	/** A document sent from memory: its file name and text. */
	fileName?: string;
	content?: string;
	/** Inline keyboard of the message, as last sent or edited. */
	buttons?: readonly (readonly InlineButton[])[];
	silent?: boolean;
};
export type FakeCall = { method: string; chatId?: number; messageId?: number; text?: string; options?: SendOptions };
type Hook = (call: FakeCall, signal: AbortSignal | undefined) => Promise<void> | void;

/** In-memory Telegram: keeps the current text of every message, records calls, and can be scripted to fail or block. */
export class FakeTelegram implements TelegramPort {
	readonly messages = new Map<number, FakeMessage>();
	readonly calls: FakeCall[] = [];
	readonly files = new Map<string, Uint8Array>();
	/** Draft frames shown, in order, per chat. */
	readonly drafts: { chatId: number; draftId: number; markdown: string }[] = [];
	readonly answeredQueries: string[] = [];
	commands: readonly BotCommandSpec[] = [];
	#nextId = 1000;
	#hooks: Hook[] = [];

	/** Run before every call; may throw to fail it or await to block it. */
	use(hook: Hook): () => void {
		this.#hooks.push(hook);
		return () => {
			this.#hooks = this.#hooks.filter((each) => each !== hook);
		};
	}

	async #enter(call: FakeCall, signal: AbortSignal | undefined): Promise<void> {
		this.calls.push(call);
		for (const hook of [...this.#hooks]) await hook(call, signal);
	}

	/** The texts of the chat's messages; a rich answer's footer is left out, so tests can match the answer itself. */
	textsIn(chatId: number): string[] {
		return [...this.messages.values()].filter((m) => m.chatId === chatId).map((m) => withoutFooter(m.text));
	}

	created(chatId: number): FakeMessage[] {
		return [...this.messages.values()].filter((m) => m.chatId === chatId);
	}

	count(method: string): number {
		return this.calls.filter((c) => c.method === method).length;
	}

	async sendMessage(chatId: number, text: string, options: SendOptions, signal?: AbortSignal): Promise<number> {
		await this.#enter({ method: "sendMessage", chatId, text, options }, signal);
		checkHtml(text, options);
		const id = this.#nextId++;
		this.messages.set(id, {
			id,
			chatId,
			text,
			html: options.html === true,
			...(options.rich === true ? { rich: true } : {}),
			kind: "text",
			...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
			...(options.buttons === undefined ? {} : { buttons: options.buttons }),
			...(options.silent === true ? { silent: true } : {}),
		});
		return id;
	}

	async editMessageText(
		chatId: number,
		messageId: number,
		text: string,
		options: SendOptions,
		signal?: AbortSignal,
	): Promise<void> {
		await this.#enter({ method: "editMessageText", chatId, messageId, text, options }, signal);
		const message = this.messages.get(messageId);
		if (message === undefined || message.chatId !== chatId)
			throw new TelegramApiError("editMessageText", 400, "Bad Request: message to edit not found");
		checkHtml(text, options);
		if (message.text === text && sameButtons(message.buttons, options.buttons))
			throw new TelegramApiError("editMessageText", 400, "Bad Request: message is not modified");
		message.text = text;
		message.html = options.html === true;
		message.rich = options.rich === true;
		if (options.buttons === undefined) delete message.buttons;
		else message.buttons = options.buttons;
	}

	async removeButtons(chatId: number, messageId: number, signal?: AbortSignal): Promise<void> {
		await this.#enter({ method: "removeButtons", chatId, messageId }, signal);
		const message = this.messages.get(messageId);
		if (message === undefined || message.chatId !== chatId)
			throw new TelegramApiError("editMessageReplyMarkup", 400, "Bad Request: message to edit not found");
		if (message.buttons === undefined)
			throw new TelegramApiError("editMessageReplyMarkup", 400, "Bad Request: message is not modified");
		delete message.buttons;
	}

	async sendDraft(chatId: number, draftId: number, markdown: string, signal?: AbortSignal): Promise<void> {
		await this.#enter({ method: "sendDraft", chatId, messageId: draftId, text: markdown }, signal);
		this.drafts.push({ chatId, draftId, markdown });
	}

	async answerCallbackQuery(queryId: string): Promise<void> {
		await this.#enter({ method: "answerCallbackQuery", text: queryId }, undefined);
		this.answeredQueries.push(queryId);
	}

	async sendChatAction(chatId: number, action: ChatAction, signal?: AbortSignal): Promise<void> {
		await this.#enter({ method: "sendChatAction", chatId, text: action }, signal);
	}

	async sendPhoto(chatId: number, path: string, caption: string | undefined, signal?: AbortSignal): Promise<number> {
		await this.#enter({ method: "sendPhoto", chatId, text: path }, signal);
		const id = this.#nextId++;
		this.messages.set(id, {
			id,
			chatId,
			text: caption ?? "",
			html: false,
			kind: "photo",
			path,
			...(caption === undefined ? {} : { caption }),
		});
		return id;
	}

	async sendDocument(chatId: number, path: string, caption: string | undefined, signal?: AbortSignal): Promise<number> {
		await this.#enter({ method: "sendDocument", chatId, text: path }, signal);
		const id = this.#nextId++;
		this.messages.set(id, { id, chatId, text: caption ?? "", html: false, kind: "document", path });
		return id;
	}

	async sendAnimation(chatId: number, path: string, caption: string | undefined, signal?: AbortSignal): Promise<number> {
		await this.#enter({ method: "sendAnimation", chatId, text: path }, signal);
		const id = this.#nextId++;
		this.messages.set(id, {
			id,
			chatId,
			text: caption ?? "",
			html: false,
			kind: "animation",
			path,
			...(caption === undefined ? {} : { caption }),
		});
		return id;
	}

	async sendTextDocument(
		chatId: number,
		fileName: string,
		text: string,
		options: DocumentOptions,
		signal?: AbortSignal,
	): Promise<number> {
		await this.#enter({ method: "sendTextDocument", chatId, text: fileName }, signal);
		const id = this.#nextId++;
		this.messages.set(id, {
			id,
			chatId,
			text: "",
			html: false,
			kind: "document",
			fileName,
			content: text,
			...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
			...(options.silent === true ? { silent: true } : {}),
		});
		return id;
	}

	/** Documents sent from memory in a chat, oldest first. */
	documentsIn(chatId: number): FakeMessage[] {
		return this.created(chatId).filter((m) => m.kind === "document" && m.fileName !== undefined);
	}

	async getFile(fileId: string, signal?: AbortSignal): Promise<{ path: string; size?: number }> {
		await this.#enter({ method: "getFile", text: fileId }, signal);
		const bytes = this.files.get(fileId);
		if (bytes === undefined) throw new TelegramApiError("getFile", 400, "Bad Request: invalid file_id");
		return { path: `files/${fileId}`, size: bytes.length };
	}

	async downloadFile(filePath: string, signal: AbortSignal): Promise<Response> {
		await this.#enter({ method: "download", text: filePath }, signal);
		const bytes = this.files.get(filePath.replace(/^files\//, ""));
		return bytes === undefined ? new Response("not found", { status: 404 }) : new Response(Buffer.from(bytes));
	}

	async setMyCommands(commands: readonly BotCommandSpec[]): Promise<void> {
		await this.#enter({ method: "setMyCommands" }, undefined);
		this.commands = commands;
	}

	async addFileFromDisk(fileId: string, path: string): Promise<void> {
		this.files.set(fileId, await readFile(path));
	}
}

function sameButtons(a: FakeMessage["buttons"], b: SendOptions["buttons"]): boolean {
	return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/** Reject unbalanced HTML the way Telegram does, so parse fallbacks can be exercised. */
function checkHtml(text: string, options: SendOptions): void {
	if (options.html !== true) return;
	if (text.includes("<broken>"))
		throw new TelegramApiError("sendMessage", 400, "Bad Request: can't parse entities: unsupported start tag");
}

/** Block a call until its signal aborts (simulates a request in flight at crash time). */
export function blockUntilAborted(signal: AbortSignal | undefined): Promise<never> {
	return new Promise((_resolve, reject) => {
		const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
		if (signal === undefined) return;
		if (signal.aborted) fail();
		signal.addEventListener("abort", fail, { once: true });
	});
}

/** An answer without its footer line (`_faux-1 · 3% · 2s_`, in HTML `<i>…</i>`), which depends on timing. */
export function withoutFooter(text: string): string {
	return text.replace(/\n\n_faux-[^\n]*_$|\n\n<i>faux-[^\n<]*<\/i>$/, "");
}

/** A message's buttons as the `reply_markup` Telegram sends with a tap. */
export function markupOf(message: FakeMessage | undefined) {
	const rows = message?.buttons ?? [];
	const keyboard = rows.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data })));
	return { inline_keyboard: keyboard };
}
