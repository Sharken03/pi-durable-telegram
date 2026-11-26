export type ChatAction = "typing" | "upload_photo" | "upload_document";

/** An inline keyboard button whose tap sends `data` (1-64 bytes) back as a callback query. */
export type InlineButton = { readonly text: string; readonly data: string };

export type SendOptions = {
	/** Parse as Telegram HTML; plain text otherwise. */
	readonly html?: boolean;
	/** The text is rich Markdown sent as a rich message (`sendRichMessage`, `rich_message` edits). */
	readonly rich?: boolean;
	/** Reply to this message of the chat (sent anyway if it is gone). */
	readonly replyTo?: number;
	/** No automatic retries: a 429 or network error is returned to the caller at once (previews, typing). */
	readonly fast?: boolean;
	/** Deliver without a sound (`disable_notification`); new messages only. */
	readonly silent?: boolean;
	/** Inline keyboard rows (`reply_markup`); an edit without them removes the keyboard. */
	readonly buttons?: readonly (readonly InlineButton[])[];
};

export type DocumentOptions = { readonly replyTo?: number; readonly silent?: boolean };

export type BotCommandSpec = { readonly command: string; readonly description: string };

/**
 * The Telegram surface the channel uses; the grammY implementation is `createGrammyPort`, tests use fakes. Methods
 * throw `TelegramApiError`, `TelegramUnknown` (non-idempotent call with unknown outcome) or `TelegramUnavailable`.
 */
export interface TelegramPort {
	sendMessage(chatId: number, text: string, options: SendOptions, signal?: AbortSignal): Promise<number>;
	editMessageText(
		chatId: number,
		messageId: number,
		text: string,
		options: SendOptions,
		signal?: AbortSignal,
	): Promise<void>;
	/** Remove the inline keyboard of a message; its text stays. */
	removeButtons(chatId: number, messageId: number, signal?: AbortSignal): Promise<void>;
	/** Show or update the ephemeral rich draft `draftId` (private chats), with a stop button. */
	sendDraft(chatId: number, draftId: number, markdown: string, signal?: AbortSignal): Promise<void>;
	/** Stop the loading state of a tapped inline button. */
	answerCallbackQuery(queryId: string): Promise<void>;
	sendChatAction(chatId: number, action: ChatAction, signal?: AbortSignal): Promise<void>;
	sendPhoto(chatId: number, path: string, caption: string | undefined, signal?: AbortSignal): Promise<number>;
	sendDocument(chatId: number, path: string, caption: string | undefined, signal?: AbortSignal): Promise<number>;
	/** An animated GIF, which Telegram plays in the chat. */
	sendAnimation(chatId: number, path: string, caption: string | undefined, signal?: AbortSignal): Promise<number>;
	/** Send `text` as a UTF-8 file named `fileName` (an answer.md, a .diff), without writing it to disk. */
	sendTextDocument(
		chatId: number,
		fileName: string,
		text: string,
		options: DocumentOptions,
		signal?: AbortSignal,
	): Promise<number>;
	/** `getFile`: the server path to download, and the size when Telegram reports it. */
	getFile(fileId: string, signal?: AbortSignal): Promise<{ path: string; size?: number }>;
	/** Download a file returned by `getFile`. The URL carries the bot token; implementations must not log it. */
	downloadFile(filePath: string, signal: AbortSignal): Promise<Response>;
	setMyCommands(commands: readonly BotCommandSpec[]): Promise<void>;
}
