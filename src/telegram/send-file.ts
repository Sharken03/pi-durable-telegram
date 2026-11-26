import { open, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	defineTool,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { isAnimatedGif, probeImage } from "../agent/tools/image-probe.ts";
import { ChatInfo } from "../channel/docs.ts";
import { truncate } from "../format/escape.ts";
import type { Logger } from "../runtime/log.ts";
import { classifyTelegramError, telegramErrorSummary } from "./errors.ts";
import type { TelegramPort } from "./port.ts";

export const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
/** Start of a GIF read to find its second frame; the frame count needs the block structure, not only the header. */
const GIF_SCAN_BYTES = 1024 * 1024;
const CAPTION_LIMIT = 1024;

type SendFileDeps = { readonly port: () => TelegramPort; readonly log: Logger; readonly uploadLimit?: number };

const parameters = obj(
	{
		path: str({ description: "File path, absolute or relative to the working directory" }),
		caption: opt(str({ description: "Optional caption, plain text, up to 1024 characters" })),
	},
	{ open: true },
);

export const SEND_FILE_TOOL = "telegram_send_file";

/**
 * `telegram_send_file`: send a workspace file to the conversation's Telegram chat, as a photo or an animation when it
 * is one.
 */
export function createSendFileTool(deps: SendFileDeps): ToolRegistration {
	const tool = defineTool({
		name: SEND_FILE_TOOL,
		description:
			"Send a file from the workspace to the user in Telegram. Images are sent as photos, animated GIFs as animations, everything else as documents. Limit 50 MB.",
		parameters,
		replay: "unsafe",
		execute: (args, api, context) => sendFile(args, api, context, deps),
	});
	return tool as unknown as ToolRegistration;
}

function failure(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }], isError: true };
}

async function sendFile(
	args: { path: string; caption?: string },
	api: ToolExecutionApi,
	context: Context,
	deps: SendFileDeps,
): Promise<ToolExecutionResult> {
	const chat = await api.snapshot(ChatInfo, api.conversationId, context);
	if (chat === undefined || chat.chatId === 0) return failure("No Telegram chat is bound to this conversation.");
	const located = await locate(args.path, (await api.agent(context)).cwd);
	if (typeof located === "string") return failure(located);
	const limit = deps.uploadLimit ?? UPLOAD_LIMIT_BYTES;
	if (located.size > limit) {
		return failure(
			`File is ${mb(located.size)} MB; Telegram bots can send at most ${mb(limit)} MB. Compress or split it.`,
		);
	}
	const caption = args.caption === undefined ? undefined : truncate(args.caption, CAPTION_LIMIT);
	const as = await sendKind(located.path, located.size);
	return upload({ chatId: chat.chatId, path: located.path, size: located.size, caption, as }, deps, context);
}

type Located = { path: string; size: number };

async function locate(path: string, cwd: string | undefined): Promise<Located | string> {
	const absolute = resolve(cwd ?? process.cwd(), path);
	try {
		const real = await realpath(absolute);
		const info = await stat(real);
		if (!info.isFile()) return `${path} is not a regular file.`;
		return { path: real, size: info.size };
	} catch {
		return `File not found or not readable: ${path}`;
	}
}

type SendKind = "photo" | "animation" | "document";

/**
 * How Telegram shows the file: a photo (not GIF, at most 10 MB, sides at most 10000 px together), an animation (a
 * GIF with more than one frame), else a document. A still GIF stays a document, as before.
 */
async function sendKind(path: string, size: number): Promise<SendKind> {
	const handle = await open(path, "r");
	try {
		const header = Buffer.alloc(GIF_SCAN_BYTES);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		const bytes = header.subarray(0, bytesRead);
		const probe = probeImage(bytes);
		if (probe === undefined) return "document";
		if (probe.mime === "image/gif") return isAnimatedGif(bytes) ? "animation" : "document";
		const fits = size <= PHOTO_LIMIT_BYTES && (probe.width ?? 0) + (probe.height ?? 0) <= 10_000;
		return fits ? "photo" : "document";
	} finally {
		await handle.close();
	}
}

type Upload = { chatId: number; path: string; size: number; caption: string | undefined; as: SendKind };

async function upload(job: Upload, deps: SendFileDeps, context: Context): Promise<ToolExecutionResult> {
	const port = deps.port();
	const signal = context.abortSignal;
	await port
		.sendChatAction(job.chatId, job.as === "photo" ? "upload_photo" : "upload_document", signal)
		.catch(() => undefined);
	try {
		const kind = await sendOnce(port, job, signal);
		return { output: [{ type: "text", text: `Sent ${basename(job.path)} (${mb(job.size)} MB) as ${kind}.` }] };
	} catch (error) {
		deps.log.warn("send_file_failed", telegramErrorSummary(error));
		return failure(uploadFailureText(error));
	}
}

async function sendOnce(
	port: TelegramPort,
	job: Upload,
	signal: AbortSignal | undefined,
): Promise<SendKind> {
	if (job.as !== "document") {
		try {
			if (job.as === "photo") await port.sendPhoto(job.chatId, job.path, job.caption, signal);
			else await port.sendAnimation(job.chatId, job.path, job.caption, signal);
			return job.as;
		} catch (error) {
			// Telegram rejects some valid images as photos or animations (dimensions, format); a document always works.
			if (classifyTelegramError(error).kind !== "rejected") throw error;
		}
	}
	await port.sendDocument(job.chatId, job.path, job.caption, signal);
	return "document";
}

function uploadFailureText(error: unknown): string {
	const kind = classifyTelegramError(error);
	if (kind.kind === "unknown") {
		return "Send outcome unknown (network error): the file may or may not have been delivered. Do not resend blindly; ask the user.";
	}
	if (kind.kind === "too_big") return "Telegram rejected the file as too big.";
	if (kind.kind === "rejected") return `Telegram rejected the file: ${kind.description}`;
	return "Sending failed: Telegram is unavailable. Try again later.";
}

function mb(bytes: number): string {
	return (bytes / 1_048_576).toFixed(1);
}
