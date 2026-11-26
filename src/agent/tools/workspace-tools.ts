import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { createEditTool } from "@earendil-works/pi-durable/tools";
import { fileCache } from "./file-cache.ts";
import { createImageReadTool, createImageRequestHook } from "./image-read.ts";
import { guardTool, realInside } from "./path-guard.ts";
import type { VisionFallback } from "./vision.ts";
import { createDiffWriteTool } from "./write-diff.ts";

export type WorkspaceToolsOptions = {
	/** The working directory: the only folder the tools may read and write. */
	readonly workdir: string;
	/** More folders `read` may open, never `write` or `edit` (the skill folders). */
	readonly readRoots?: readonly string[];
	/** PATH-like list where `read` finds pdfinfo, pdftotext, pdftoppm and heif-dec; default the process PATH. */
	readonly programPath?: string;
	/** Folder for rendered PDF pages and converted photos; default a folder in the system temp folder. */
	readonly cacheDir?: string;
	/** Describes images for a model without image input; none: such a model gets a note instead. */
	readonly vision?: VisionFallback;
};

/**
 * `read` (with images, PDF and Office files), `write` (with a diff) and `edit`, with no shell tool; replaces
 * pi-durable's CodingTools. Each tool refuses a path outside the working directory, also through a symlink. The image
 * hook attaches images only from there and from the cache folder, where `read` itself puts the pictures it makes.
 */
export function createWorkspaceTools(options: WorkspaceToolsOptions): Extension {
	const roots = [options.workdir];
	const readRoots = [...roots, ...(options.readRoots ?? [])];
	const cacheDir = options.cacheDir ?? join(tmpdir(), "pi-durable-telegram-files");
	const imageRoots = [...readRoots, cacheDir];
	const read = createImageReadTool({
		programs: { path: options.programPath ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
		cache: fileCache(cacheDir),
		...(options.vision === undefined ? {} : { vision: options.vision }),
	});
	return defineExtension({
		name: "workspace",
		tools: [
			guardTool(read, readRoots),
			guardTool(createDiffWriteTool(), roots),
			guardTool(eraseTool(createEditTool()), roots),
		],
		hooks: [createImageRequestHook(async (path) => (await realInside(path, imageRoots)) !== undefined)],
	});
}

/** Stock tools are typed by their own schemas; a registry holds them erased. */
function eraseTool(tool: object): ToolRegistration {
	return tool as ToolRegistration;
}
