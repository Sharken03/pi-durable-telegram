import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import type { CallbackQuery } from "grammy/types";
import { DIFF_DATA, diffFor } from "../delivery/run-view.ts";
import { RETRY_DATA, STOP_DATA } from "../delivery/send-phase.ts";
import type { DeliverInput } from "../delivery/types.ts";
import { contextLine, markChosen } from "../format/rich.ts";
import { isFatalHarnessError } from "../runtime/fatal.ts";
import { errorSummary } from "../runtime/log.ts";
import { telegramErrorSummary } from "../telegram/errors.ts";
import { handlePanelTap, isPanelData } from "./commands/model.ts";
import { runStop } from "./commands/stop.ts";
import { Buttons, Diffs, Retries, rememberButtons } from "./docs.ts";
import { admit, admitIn } from "./intake.ts";
import type { ChannelRuntime } from "./scope.ts";
import { withoutTimeStamp, withTimeStamp } from "./time-stamp.ts";

const CONTEXT_CHARS = 1500;
export const DIFF_GONE_TEXT = "This diff is no longer kept.";

type Tap = { chatId: number; messageId: number; sent: string; data: string };

/**
 * A tap on an answer's button is the user's next message: the time of the tap, the button's data and a line naming
 * the message it was under. It is admitted once per callback query, so a redelivered tap is a duplicate; then the
 * message shows the choice. Buttons of any old message work; without the sent Markdown the choice is just not marked.
 * Retry and Stop under an error message, Full diff under an answer and the model panel are handled here, not sent to
 * the model.
 */
export async function handleTap(rt: ChannelRuntime, query: CallbackQuery): Promise<void> {
	await rt.port.answerCallbackQuery(query.id).catch((error: unknown) => {
		rt.log.debug("callback_answer_failed", telegramErrorSummary(error));
	});
	const message = query.message;
	if (query.data === undefined || message === undefined) return;
	const chatId = message.chat.id;
	const messageId = message.message_id;
	const conversation = await rt.directory.get(chatId, BG);
	if (query.data === RETRY_DATA) return retry(rt, conversation, { chatId, messageId, queryId: query.id });
	if (query.data === STOP_DATA) return stop(rt, conversation, { chatId, messageId, queryId: query.id });
	if (isPanelData(query.data)) {
		const markup = "reply_markup" in message ? message.reply_markup : undefined;
		return handlePanelTap(rt, conversation, { chatId, messageId, queryId: query.id, data: query.data, markup });
	}
	if (query.data.startsWith(DIFF_DATA)) {
		const which = query.data.slice(DIFF_DATA.length);
		rt.track(sendDiff(rt, conversation, { chatId, messageId, queryId: query.id }, which));
		return;
	}
	const sent = (await rt.harness.snapshot(Buttons, conversation.id, BG))?.messages[String(messageId)];
	const context = contextLine(sent ?? ("text" in message ? (message.text ?? "") : ""), CONTEXT_CHARS);
	const body = context === "" ? query.data : `${query.data}\n\n(button under your message: «${context}»)`;
	const content = withTimeStamp(body, new Date());
	const input = { chatId, messageId, requestId: `tg:${chatId}:cq:${query.id}`, content };
	const result = await admit(conversation, rt.deliver, input, BG);
	rt.log.info(result === "admitted" ? "tap_admitted" : "update_duplicate", { chat: chatId, message: messageId });
	if (result === "admitted" && sent !== undefined)
		rt.track(markChoice(rt, conversation, { chatId, messageId, sent, data: query.data }));
}

/** Mark the tapped button and disable the other choices of its row; failures are logged, never thrown. */
async function markChoice(rt: ChannelRuntime, conversation: Conversation, tap: Tap): Promise<void> {
	const marked = markChosen(tap.sent, tap.data);
	if (marked === undefined) return;
	try {
		await rt.port.editMessageText(tap.chatId, tap.messageId, marked, { rich: true });
		await conversation.commit(
			async (tx) => rememberButtons(await tx.doc(Buttons, conversation.id), tap.messageId, marked),
			BG,
		);
	} catch (error) {
		rt.log.warn("tap_mark_failed", { chat: tap.chatId, ...telegramErrorSummary(error) });
	}
}

type ErrorTap = { chatId: number; messageId: number; queryId: string };

/**
 * Retry under an error message: admit the request behind it again, with the time of the tap, as a reply to the same
 * user message. The kept request is removed in the same commit, so a second tap does nothing; the buttons go.
 */
async function retry(rt: ChannelRuntime, conversation: Conversation, tap: ErrorTap): Promise<void> {
	const id = conversation.id;
	const kept = (await rt.harness.snapshot(Retries, id, BG))?.messages[String(tap.messageId)];
	if (kept === undefined) {
		rt.log.info("retry_unknown", { chat: tap.chatId, message: tap.messageId });
		rt.track(removeButtons(rt, tap));
		return;
	}
	const { content: old } = kept;
	const content = typeof old === "string" ? withTimeStamp(withoutTimeStamp(old), rt.now()) : old;
	const input: DeliverInput = {
		chatId: tap.chatId,
		...(kept.replyTo === undefined ? {} : { messageId: kept.replyTo }),
		requestId: `tg:${tap.chatId}:cq:${tap.queryId}`,
		content,
	};
	const admitted = await conversation.commit(async (tx) => {
		if (!(await admitIn(tx, id, rt.deliver, input))) return false;
		const retries = await tx.doc(Retries, id);
		delete retries.messages[String(tap.messageId)];
		retries.order = retries.order.filter((messageId) => messageId !== tap.messageId);
		return true;
	}, BG);
	rt.log.info(admitted ? "retry_admitted" : "update_duplicate", { chat: tap.chatId, message: tap.messageId });
	if (admitted) rt.track(removeButtons(rt, tap));
}

/** Stop under an error message: /stop for what runs now, once per callback query; the buttons go. */
async function stop(rt: ChannelRuntime, conversation: Conversation, tap: ErrorTap): Promise<void> {
	const key = `tg:${tap.chatId}:cq:${tap.queryId}`;
	const scope = { rt, conversation, chatId: tap.chatId, messageId: tap.messageId, key };
	const work = runStop(scope).catch((error: unknown) => {
		if (isFatalHarnessError(error)) rt.onFatal("storage failure in /stop", error);
		else rt.log.error("command_failed", { command: "stop", error: errorSummary(error) });
	});
	rt.track(work.then(() => removeButtons(rt, tap)));
}

/** Full diff under an answer: the kept diff as a .diff document, or a short note when it is no longer kept. */
async function sendDiff(rt: ChannelRuntime, conversation: Conversation, tap: ErrorTap, which: string): Promise<void> {
	const fields = { chat: tap.chatId, message: tap.messageId };
	try {
		const files = (await rt.harness.snapshot(Diffs, conversation.id, BG))?.messages[String(tap.messageId)];
		const diff = diffFor(files, which);
		const options = { replyTo: tap.messageId, silent: true };
		if (diff === undefined) {
			rt.log.info("diff_unknown", fields);
			await rt.port.sendMessage(tap.chatId, DIFF_GONE_TEXT, options);
			return;
		}
		await rt.port.sendTextDocument(tap.chatId, diff.name, diff.text, options);
		rt.log.info("diff_sent", { ...fields, name: diff.name });
	} catch (error) {
		if (isFatalHarnessError(error)) rt.onFatal("storage failure in Full diff", error);
		else rt.log.warn("diff_send_failed", { ...fields, error: errorSummary(error) });
	}
}

async function removeButtons(rt: ChannelRuntime, tap: ErrorTap): Promise<void> {
	try {
		await rt.port.removeButtons(tap.chatId, tap.messageId);
	} catch (error) {
		rt.log.debug("remove_buttons_failed", { chat: tap.chatId, ...telegramErrorSummary(error) });
	}
}
