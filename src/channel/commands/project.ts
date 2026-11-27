import { isAbsolute, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { phoneClient } from "../../plugins/workers/task.ts";
import { ChatSettings } from "../docs.ts";
import { recordKey } from "../intake.ts";
import { type MessageScope, reply } from "../scope.ts";

/**
 * `/project` shows the directory this chat works in; `/project <path>` makes it the chat's own, so one topic can hold
 * `varmehub` while another holds `happier`; `/project default` goes back to the projects root.
 *
 * The directory lives on the phone, not on the machine the bot runs on: it is read and written with the phone's own
 * tools (`read_project_file`, `edit_project_file`, …), which is where the room is and where the work happens. A name
 * is resolved against the projects root (`PI_PHONE_PROJECTS`), and nothing can leave it.
 */
export async function runProject(scope: MessageScope, args: string): Promise<void> {
	if (!(await recordKey(scope.conversation, scope.key, BG, scope.updateId))) return;
	const root = scope.rt.phoneProjects;
	const wanted = args.trim();
	if (wanted === "") {
		const stored = await current(scope);
		await reply(scope, `Project: ${stored ?? `${root} (the default)`}`);
		return;
	}
	if (wanted === "default" || wanted === "-") {
		await store(scope, undefined);
		await reply(scope, `Project: ${root} (the default)`);
		return;
	}
	if (wanted.length > 200) {
		await reply(scope, "That path is too long.");
		return;
	}
	const target = isAbsolute(wanted) ? resolve(wanted) : resolve(root, wanted);
	if (!inside(root, target)) {
		await reply(scope, `Only directories inside ${root} on the phone can be a project.`);
		return;
	}
	const problem = await makeOnPhone(target);
	if (problem !== undefined) {
		await reply(scope, problem);
		return;
	}
	await store(scope, target);
	await reply(scope, `Project: ${target}`);
}

/** The chat's project, or undefined while it uses the root. */
async function current(scope: MessageScope): Promise<string | undefined> {
	const settings = await scope.rt.harness.snapshot(ChatSettings, scope.conversation.id, BG);
	return settings?.project;
}

async function store(scope: MessageScope, project: string | undefined): Promise<void> {
	await scope.conversation.commit(async (tx) => {
		const doc = await tx.doc(ChatSettings, scope.conversation.id);
		if (project === undefined) delete doc.project;
		else doc.project = project;
	}, BG);
}

/** True when `path` is `root` itself or below it; both are absolute and normalized. */
function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The project must exist on the phone before a chat works there, so it is made when it is not there yet. Without the
 * worker plugin the phone cannot be reached: the path is kept, and the first tool call says what is missing.
 */
async function makeOnPhone(path: string): Promise<string | undefined> {
	const client = phoneClient();
	if (client === undefined) return undefined;
	try {
		await client.json("make_project_dir", { path });
		return undefined;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return reason.includes("outside") || reason.includes("not allowed")
			? `The phone does not allow ${path}: ${reason}`
			: `Could not make ${path} on the phone: ${reason}`;
	}
}
