import { readFile, stat } from "node:fs/promises";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Api, ImageContent, Message, Model, Models, TextContent, Usage } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	GenerationTask,
	type HookApi,
	type HookRegistration,
	hook,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { ProgramError, type ProgramPath } from "../../media/programs.ts";
import { isPdf } from "../../media/sniff.ts";
import type { FileCache, SourceId } from "./file-cache.ts";
import { type ImageMime, type ImageProbe, maxImageBytes, probeImage } from "./image-probe.ts";
import { MAX_PAGES_PER_READ, type RenderedPage, readPdf } from "./pdf-read.ts";
import { addUsage, type Description, type VisionFallback, type VisionImage } from "./vision.ts";

const MAX_DIMENSION = 8000;
const HEADER_BYTES = 64 * 1024;
/** Images re-attached per request; older ones are replaced by a note to keep requests small. */
export const IMAGES_PER_REQUEST = 4;

/**
 * One image a `read` result shows: the request hook attaches the file at `path` for each request. `described`: the
 * result text already has a vision model's description, so a model without image input needs no note.
 */
export type ImageRef = { readonly path: string; readonly mime: ImageMime; readonly described?: true };
export type ReadDetails = { readonly images: readonly ImageRef[] };

export type ReadToolOptions = {
	/** Where pdfinfo, pdftotext and pdftoppm are looked up. */
	readonly programs: ProgramPath;
	/** Rendered pages live here, so the request hook can attach them later. */
	readonly cache: FileCache;
	/** Describes images when the conversation's model has no image input; none: such a model gets a note. */
	readonly vision?: VisionFallback;
};

/** The stock `read` parameters plus `pages` for PDF files. */
const readParameters = obj(
	{
		path: str({ description: "Path to the file to read (relative or absolute)" }),
		offset: opt(num({ description: "Line number to start reading from (1-indexed)" })),
		limit: opt(num({ description: "Maximum number of lines to read" })),
		pages: opt(
			str({ description: `PDF files only: the pages to read, such as "3" or "3-5"; at most ${MAX_PAGES_PER_READ}` }),
		),
	},
	{ open: true },
);

type ReadArgs = { path: string; pages?: unknown };

/** A model that is unknown counts as one that can view images. */
function canView(model: Model<Api> | undefined): boolean {
	return model === undefined || model.input.includes("image");
}

export type ImageCheck = { ok: true; probe: ImageProbe } | { ok: false; reason: string };

/** Validate an image before it may be attached: type, byte size and dimensions. */
export function checkImage(bytes: Uint8Array, size: number, maxBytes: number): ImageCheck {
	const probe = probeImage(bytes);
	if (probe === undefined) return { ok: false, reason: "not a PNG, JPEG, WebP or GIF image" };
	const dims = probe.width === undefined ? "unknown size" : `${probe.width}x${probe.height}`;
	const tooWide = (probe.width ?? 0) > MAX_DIMENSION || (probe.height ?? 0) > MAX_DIMENSION;
	if (size > maxBytes || tooWide) {
		return {
			ok: false,
			reason:
				`Image too large to view (${megabytes(size)} MB, ${dims}; limit ${megabytes(maxBytes)} MB and ${MAX_DIMENSION} px). ` +
				"Downscale it first, e.g. with ImageMagick: `convert in.png -resize 2000x2000 out.jpg`",
		};
	}
	return { ok: true, probe };
}

function megabytes(bytes: number): string {
	return (bytes / 1_048_576).toFixed(1);
}

async function modelOf(models: Models, ref: { provider: string; modelId: string } | undefined) {
	return ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
}

/**
 * `read` that recognizes images and PDF files by content. An image result is a short text with the canonical path in
 * `details`; the generation hook attaches the bytes per request, so they never enter durable history. A PDF result is
 * its text, with pages that have no text rendered as images in the same way. Other files go to the stock `read`.
 */
export function createImageReadTool(options: ReadToolOptions): ToolRegistration {
	const read = createReadTool() as unknown as ToolRegistration;
	return {
		...read,
		description:
			`${read.description} Images (PNG, JPEG, WebP, GIF) are shown to you as pictures. ` +
			`A PDF gives its page count and the text of up to ${MAX_PAGES_PER_READ} pages per call; choose pages with ` +
			'pages, such as "3-5". PDF pages without text are shown as pictures.',
		parameters: readParameters,
		execute: async (args, api, context) => {
			const input = args as ReadArgs;
			const file = await openFile(String(input.path), api, context);
			const special = file === undefined ? undefined : await readSpecial(file, input, api, context, options);
			return special ?? read.execute(args, api, context);
		},
	};
}

type OpenedFile = SourceId & { readonly header: Uint8Array };

/** The canonical path, size, modification time and first bytes of a file; undefined when it cannot be read. */
async function openFile(path: string, api: ToolExecutionApi, context: Context): Promise<OpenedFile | undefined> {
	const env = api.env;
	if (env === undefined) return undefined;
	const canonical = await env.canonicalPath(path, context);
	if (!canonical.ok) return undefined;
	const reader = await env.openBinaryReader(canonical.value, undefined, context);
	if (!reader.ok) return undefined;
	const [info, header] = await Promise.all([
		reader.value.info(context),
		reader.value.read(0, HEADER_BYTES, context),
	]).finally(() => reader.value.close(context));
	if (!info.ok || !header.ok) return undefined;
	return { path: canonical.value, size: info.value.size, mtimeMs: info.value.mtimeMs, header: header.value };
}

async function readSpecial(
	file: OpenedFile,
	input: ReadArgs,
	api: ToolExecutionApi,
	context: Context,
	options: ReadToolOptions,
): Promise<ToolExecutionResult | undefined> {
	const call: Call = { api, context, options, model: await currentModel(api, context) };
	if (probeImage(file.header) !== undefined) return readImage(file, call);
	if (isPdf(file.header)) return readPdfFile(file, input.pages, call);
	return undefined;
}

/** What one `read` call works with: the conversation's model is looked up once. */
type Call = {
	readonly api: ToolExecutionApi;
	readonly context: Context;
	readonly options: ReadToolOptions;
	readonly model: Model<Api> | undefined;
};

async function currentModel(api: ToolExecutionApi, context: Context): Promise<Model<Api> | undefined> {
	return modelOf(api.models, (await api.agent(context)).model);
}

/** The vision fallback when the model cannot view images and one is set; undefined otherwise. */
function fallbackFor(call: Call): VisionFallback | undefined {
	return canView(call.model) ? undefined : call.options.vision;
}

async function readImage(file: OpenedFile, call: Call): Promise<ToolExecutionResult> {
	const check = checkImage(file.header, file.size, maxImageBytes(call.model));
	if (!check.ok) return failure(check.reason);
	const { width, height, mime } = check.probe;
	const head = `Image ${file.path} (${width ?? "?"}x${height ?? "?"}, ${megabytes(file.size)} MB)`;
	const image: ImageRef = { path: file.path, mime };
	const vision = fallbackFor(call);
	if (vision === undefined) return success(`${head} is attached for viewing.`, [image]);
	const described = await describeFile(vision, image, "picture", call.context);
	if (!described.ok) {
		const why = `This model cannot view images, and the vision model ${vision.label} could not describe it`;
		return success(`${head}. ${why}: ${described.reason}.`, [image]);
	}
	const intro = `This model cannot view images; the vision model ${vision.label} describes it:`;
	return success(`${head}. ${intro}\n\n${described.text}`, [{ ...image, described: true }], described.usage);
}

async function describeFile(
	vision: VisionFallback,
	image: ImageRef,
	kind: VisionImage["kind"],
	context: Context,
): Promise<Description> {
	const data = await readFile(image.path).catch(() => undefined);
	if (data === undefined) return { ok: false, reason: "the file could not be read" };
	return vision.describe({ data, mime: image.mime, kind }, context.abortSignal);
}

async function readPdfFile(file: OpenedFile, pages: unknown, call: Call): Promise<ToolExecutionResult> {
	const vision = fallbackFor(call);
	let usage: Usage | undefined;
	const describe = async (page: RenderedPage): Promise<string> => {
		if (vision === undefined) throw new Error("describe without a vision model");
		const described = await describeFile(vision, page, "page", call.context);
		if (!described.ok) return `[The vision model ${vision.label} could not read this page: ${described.reason}.]`;
		usage = addUsage(usage, described.usage);
		return `[Read by the vision model ${vision.label}:]\n${described.text}`;
	};
	try {
		const result = await readPdf(file, typeof pages === "string" ? pages : undefined, {
			programs: call.options.programs,
			cache: call.options.cache,
			maxImageBytes: maxImageBytes(call.model),
			scans: canView(call.model) ? "view" : vision === undefined ? "none" : "describe",
			describe,
			...(call.context.abortSignal === undefined ? {} : { signal: call.context.abortSignal }),
		});
		if (typeof result === "string") return failure(`Cannot read the PDF ${file.path}: ${result}.`);
		const described = vision === undefined ? {} : { described: true as const };
		const images = result.renders.map((page) => ({ path: page.path, mime: page.mime, ...described }));
		return success(result.text, images, usage);
	} catch (error) {
		if (error instanceof ProgramError) return failure(`Cannot read the PDF ${file.path}: ${error.message}`);
		throw error;
	}
}

/** A result for the model; programs that call `read` get the same text. `usage`: a vision model's spend. */
function success(value: string, images: readonly ImageRef[], usage?: Usage): ToolExecutionResult {
	const details: ReadDetails = { images };
	return {
		output: [text(value)],
		structuredOutput: value,
		details: details as unknown as JsonValue,
		...(usage === undefined ? {} : { usage }),
	};
}

function failure(value: string): ToolExecutionResult {
	return { output: [text(value)], isError: true };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

type ToolResult = Extract<Message, { role: "toolResult" }>;

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

type AttachedImage = { readonly path: string; readonly described: boolean };

/**
 * The trusted images of a `read` result: only `details` count, never text. Results from before PDF support carry
 * one `imagePath` instead of `images`.
 */
export function imagesOf(message: Message): AttachedImage[] {
	if (message.role !== "toolResult" || message.toolName !== "read") return [];
	const details = message.details as JsonValue | undefined;
	if (!isRecord(details)) return [];
	if (typeof details.imagePath === "string") return [{ path: details.imagePath, described: false }];
	const images = details.images;
	if (!Array.isArray(images)) return [];
	return images.flatMap((image) =>
		isRecord(image) && typeof image.path === "string" ? [{ path: image.path, described: image.described === true }] : [],
	);
}

/** Re-attach the newest images to the request; older ones get a note. */
export async function attachImages(
	messages: readonly Message[],
	options: { maxBytes: number; canView: boolean },
): Promise<Message[]> {
	const slots = messages.flatMap((message, index) => imagesOf(message).map((_, image) => `${index}:${image}`));
	const recent = new Set(slots.slice(-IMAGES_PER_REQUEST));
	return Promise.all(
		messages.map(async (message, index) => {
			const images = imagesOf(message);
			if (images.length === 0) return message;
			const result = message as ToolResult;
			if (!options.canView) {
				// A vision model's description in the result text already stands in for the pictures.
				if (images.every((image) => image.described)) return message;
				return appendContent(result, [text("[this model cannot view images]")]);
			}
			const parts = await Promise.all(
				images.map(({ path }, image) =>
					recent.has(`${index}:${image}`)
						? loadImage(path, options.maxBytes)
						: text("[image omitted to save context; read it again to view]"),
				),
			);
			return appendContent(result, parts);
		}),
	);
}

function appendContent(message: ToolResult, parts: readonly (TextContent | ImageContent)[]): ToolResult {
	return { ...message, content: [...message.content, ...parts] } as ToolResult;
}

async function loadImage(path: string, maxBytes: number): Promise<TextContent | ImageContent> {
	try {
		const info = await stat(path);
		if (info.size > maxBytes) return text(`[image no longer available: larger than ${megabytes(maxBytes)} MB]`);
		const bytes = await readFile(path);
		const check = checkImage(bytes, bytes.length, maxBytes);
		if (!check.ok) return text(`[image no longer available: ${check.reason}]`);
		return { type: "image", data: bytes.toString("base64"), mimeType: check.probe.mime };
	} catch {
		return text("[image no longer available: file missing or unreadable; read it again]");
	}
}

async function requestModel(api: HookApi, context: Context) {
	const agent = await api.snapshot(AgentDoc, api.conversationId, context);
	return modelOf(api.models, agent?.model);
}

/** Generation hook that attaches image bytes for `read` results at request time. */
export function createImageRequestHook(): HookRegistration {
	return hook(GenerationTask, {
		beforeRequest: async (request, api, context) => {
			if (!request.messages.some((message) => imagesOf(message).length > 0)) return undefined;
			const model = await requestModel(api, context);
			const messages = await attachImages(request.messages, { maxBytes: maxImageBytes(model), canView: canView(model) });
			return { messages };
		},
	});
}
