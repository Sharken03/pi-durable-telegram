import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { createImageReadTool, createImageRequestHook } from "./image-read.ts";

/** `read` (with images), `write` and `edit`, with no shell tool; replaces pi-durable's CodingTools. */
export function createWorkspaceTools(): Extension {
	return defineExtension({
		name: "workspace",
		tools: [createImageReadTool(), eraseTool(createWriteTool()), eraseTool(createEditTool())],
		hooks: [createImageRequestHook()],
	});
}

/** Stock tools are typed by their own schemas; a registry holds them erased. */
function eraseTool(tool: object): ToolRegistration {
	return tool as ToolRegistration;
}
