import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { ChatSettings } from "../docs.ts";
import { recordKey } from "../intake.ts";
import { type MessageScope, reply } from "../scope.ts";

/**
 * `/project` shows the directory this chat works in; `/project <path>` makes it the chat's own, so one topic can hold
 * `varmehub` while another holds `happier`; `/project default` goes back to the bot's working directory.
 *
 * The path is resolved against the bot's working directory, never against the current one, so the same command means
 * the same thing twice. It must lie inside the working directory: the chat's directory is a place to work, not a way
 * out of the sandbox the bot was given. A directory that is not there yet is made, so /project names a new project as
 * easily as an old one.
 */
export async function runProject(scope: MessageScope, args: string): Promise<void> {
	if (!(await recordKey(scope.conversation, scope.key, BG, scope.updateId))) return;
	const root = scope.rt.workdir;
	const wanted = args.trim();
	if (wanted === "") {
		const current = (await scope.conversation.agent(BG)).cwd;
		const note = current === root ? ` (the default)` : "";
		await reply(scope, `Project: ${current}${note}`);
		return;
	}
	if (wanted === "default" || wanted === "-") {
		await apply(scope, undefined, root);
		await reply(scope, `Project: ${root} (the default)`);
		return;
	}
	if (wanted.length > 200) {
		await reply(scope, "That path is too long.");
		return;
	}
	const target = isAbsolute(wanted) ? resolve(wanted) : resolve(root, wanted);
	if (!inside(root, target)) {
		await reply(scope, `Only directories inside ${root} can be a project.`);
		return;
	}
	const problem = check(target, root);
	if (problem !== undefined) {
		await reply(scope, problem);
		return;
	}
	const real = realpathSync(target);
	if (!inside(realpathSync(root), real)) {
		await reply(scope, `Only directories inside ${root} can be a project (that path is a link out of it).`);
		return;
	}
	await apply(scope, real, root);
	await reply(scope, `Project: ${real}`);
}

/** The stored directory and the conversation's agent in one step, so a restart and a running run agree. */
async function apply(scope: MessageScope, cwd: string | undefined, root: string): Promise<void> {
	await scope.conversation.commit(async (tx) => {
		const doc = await tx.doc(ChatSettings, scope.conversation.id);
		if (cwd === undefined || cwd === root) delete doc.cwd;
		else doc.cwd = cwd;
	}, BG);
	await scope.conversation.configure({ cwd: cwd ?? root }, BG);
}

/** True when `path` is `root` itself or below it; both are absolute and normalized. */
function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Why `path` cannot be a project, or undefined when it can. A directory that is not there yet is made, but only when
 * the nearest existing parent really is inside the working directory, so a link out of it cannot be used to create
 * anything outside.
 */
function check(path: string, root: string): string | undefined {
	let stats;
	try {
		stats = statSync(path);
	} catch {
		let parent = path;
		while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
		let real: string;
		try {
			real = realpathSync(parent);
		} catch {
			return `There is no access to ${path}.`;
		}
		if (!inside(realpathSync(root), real)) {
			return `Only directories inside ${root} can be a project (that path is a link out of it).`;
		}
		try {
			mkdirSync(path, { recursive: true });
			stats = statSync(path);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return `Could not create ${path}: ${reason}`;
		}
	}
	if (!stats.isDirectory()) return `${path} is not a directory.`;
	try {
		accessSync(path, constants.X_OK);
	} catch {
		return `There is no access to ${path}.`;
	}
	return undefined;
}
