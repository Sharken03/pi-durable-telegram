import type { Api, Model, MutableModels, Usage } from "@earendil-works/pi-ai";
import { errorSummary } from "../../runtime/log.ts";
import { loadProvider } from "../providers.ts";
import { maxImageBytes } from "./image-probe.ts";

/**
 * A second model that describes images for a main model without image input, so the main model keeps its context and
 * still learns what an image shows. `PI_VISION_MODEL` chooses it.
 */
export type VisionFallback = {
	/** `provider/model`, for the text the main model gets. */
	readonly label: string;
	/** A description of one image, or why there is none. Never throws. */
	describe(image: VisionImage, signal?: AbortSignal): Promise<Description>;
};

export type VisionImage = {
	readonly data: Buffer;
	readonly mime: string;
	/** A scanned document page gets a transcription prompt; a picture gets a description prompt. */
	readonly kind: "picture" | "page";
};

export type Description =
	| { readonly ok: true; readonly text: string; readonly usage: Usage }
	| { readonly ok: false; readonly reason: string };

export type ModelRef = { readonly provider: string; readonly modelId: string };

const MAX_TOKENS = 2048;
const TIMEOUT_MS = 120_000;

const PROMPTS = {
	picture:
		"Describe this image for an assistant that cannot see it. First transcribe all visible text exactly, in its " +
		"original language. Then describe what matters: layout, objects, people, charts with their values, colours. " +
		"Be complete and concise. No preamble.",
	page:
		"This is a document page without a text layer. Transcribe all text exactly, in reading order and in its original " +
		"language; write tables as Markdown tables. Then name pictures, stamps or signatures in one line each. No preamble.",
} as const;

/**
 * The fallback on `ref`. Its provider is registered on first use when it is not the main one; a failed lookup is
 * tried again on the next image, so a later `login` takes effect without a restart.
 */
export function createVisionFallback(ref: ModelRef, models: MutableModels): VisionFallback {
	const label = `${ref.provider}/${ref.modelId}`;
	let ready: Promise<Model<Api> | string> | undefined;
	return {
		label,
		describe: async (image, signal) => {
			ready ??= resolveModel(ref, models);
			const model = await ready;
			if (typeof model === "string") {
				ready = undefined;
				return { ok: false, reason: model };
			}
			if (image.data.length > maxImageBytes(model)) return { ok: false, reason: "the image is too large for it" };
			return ask(models, model, image, signal);
		},
	};
}

async function resolveModel(ref: ModelRef, models: MutableModels): Promise<Model<Api> | string> {
	try {
		if (models.getModels(ref.provider).length === 0) {
			const provider = await loadProvider(ref.provider);
			if (provider === undefined) return `unknown provider ${ref.provider}`;
			models.setProvider(provider);
		}
		const model = models.getModel(ref.provider, ref.modelId);
		if (model === undefined) return "unknown model";
		if (!model.input.includes("image")) return "it does not take images";
		if ((await models.checkAuth(ref.provider)) === undefined) return `not logged in to ${ref.provider}`;
		return model;
	} catch (error) {
		return errorSummary(error);
	}
}

async function ask(
	models: MutableModels,
	model: Model<Api>,
	image: VisionImage,
	signal: AbortSignal | undefined,
): Promise<Description> {
	try {
		const answer = await models.completeSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: PROMPTS[image.kind] },
							{ type: "image", data: image.data.toString("base64"), mimeType: image.mime },
						],
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
		);
		if (answer.stopReason === "error" || answer.stopReason === "aborted") {
			return { ok: false, reason: answer.errorMessage ?? `the request ended with ${answer.stopReason}` };
		}
		const text = answer.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("")
			.trim();
		if (text === "") return { ok: false, reason: "it answered with no text" };
		return { ok: true, text, usage: answer.usage };
	} catch (error) {
		return { ok: false, reason: errorSummary(error) };
	}
}

/** The sum of two usages, for a read that asks the fallback more than once. */
export function addUsage(total: Usage | undefined, usage: Usage): Usage {
	if (total === undefined) return usage;
	return {
		input: total.input + usage.input,
		output: total.output + usage.output,
		cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite,
		totalTokens: total.totalTokens + usage.totalTokens,
		cost: {
			input: total.cost.input + usage.cost.input,
			output: total.cost.output + usage.cost.output,
			cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
			cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
			total: total.cost.total + usage.cost.total,
		},
	};
}
