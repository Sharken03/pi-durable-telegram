import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { createEditTool } from "@earendil-works/pi-durable/tools";
import { fileCache } from "./file-cache.ts";
import { createImageReadTool, createImageRequestHook } from "./image-read.ts";
import { createDiffWriteTool } from "./write-diff.ts";

export type WorkspaceToolsOptions = {
	/** PATH-like list where `read` finds pdfinfo, pdftotext and pdftoppm; default the process PATH. */
	readonly programPath?: string;
	/** Folder for rendered PDF pages; default a folder in the system temp folder. */
	readonly cacheDir?: string;
};

/**
 * `read` (with images and PDF files), `write` (with a diff) and `edit`, with no shell tool; replaces pi-durable's
 * CodingTools.
 */
export function createWorkspaceTools(options: WorkspaceToolsOptions = {}): Extension {
	const read = createImageReadTool({
		programs: { path: options.programPath ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
		cache: fileCache(options.cacheDir ?? join(tmpdir(), "pi-durable-telegram-files")),
	});
	return defineExtension({
		name: "workspace",
		tools: [read, createDiffWriteTool(), eraseTool(createEditTool())],
		hooks: [createImageRequestHook()],
	});
}

/** Stock tools are typed by their own schemas; a registry holds them erased. */
function eraseTool(tool: object): ToolRegistration {
	return tool as ToolRegistration;
}
