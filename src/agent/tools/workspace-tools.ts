import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { createEditTool } from "@earendil-works/pi-durable/tools";
import { createImageReadTool, createImageRequestHook } from "./image-read.ts";
import { guardTool, realInside } from "./path-guard.ts";
import { createDiffWriteTool } from "./write-diff.ts";

export type WorkspaceToolsOptions = {
	/** The working directory: the only folder the tools may read and write. */
	readonly workdir: string;
	/** More folders `read` may open, never `write` or `edit` (the skill folders). */
	readonly readRoots?: readonly string[];
};

/**
 * `read` (with images), `write` (with a diff) and `edit`, with no shell tool; replaces pi-durable's CodingTools. Each
 * tool refuses a path outside the working directory, also through a symlink, and the image hook attaches no image
 * from outside it.
 */
export function createWorkspaceTools(options: WorkspaceToolsOptions): Extension {
	const roots = [options.workdir];
	const readRoots = [...roots, ...(options.readRoots ?? [])];
	return defineExtension({
		name: "workspace",
		tools: [
			guardTool(createImageReadTool(), readRoots),
			guardTool(createDiffWriteTool(), roots),
			guardTool(eraseTool(createEditTool()), roots),
		],
		hooks: [createImageRequestHook(async (path) => (await realInside(path, readRoots)) !== undefined)],
	});
}

/** Stock tools are typed by their own schemas; a registry holds them erased. */
function eraseTool(tool: object): ToolRegistration {
	return tool as ToolRegistration;
}
