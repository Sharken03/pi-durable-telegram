import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { createEditTool } from "@earendil-works/pi-durable/tools";
import { createImageReadTool, createImageRequestHook } from "./image-read.ts";
import { createDiffWriteTool } from "./write-diff.ts";

/** `read` (with images), `write` (with a diff) and `edit`, with no shell tool; replaces pi-durable's CodingTools. */
export function createWorkspaceTools(): Extension {
	return defineExtension({
		name: "workspace",
		tools: [createImageReadTool(), createDiffWriteTool(), eraseTool(createEditTool())],
		hooks: [createImageRequestHook()],
	});
}

/** Stock tools are typed by their own schemas; a registry holds them erased. */
function eraseTool(tool: object): ToolRegistration {
	return tool as ToolRegistration;
}
