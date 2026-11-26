import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function outsideText(path: string): string {
	return `Path is outside the working directory: ${path}`;
}

/**
 * The real path of `path` when it is one of `roots` or lies under one, with every symlink followed: an existing path
 * by its own real path, a new one by the real path of its nearest existing parent. Undefined otherwise, also for a
 * link that points to nothing (a write would follow it) and for a path that cannot be checked.
 */
export async function realInside(path: string, roots: readonly string[]): Promise<string | undefined> {
	const real = await realOf(path);
	if (real === undefined) return undefined;
	for (const root of roots) {
		const base = await realpath(resolve(root)).catch(() => undefined);
		if (base !== undefined && isUnder(real, base)) return real;
	}
	return undefined;
}

function isUnder(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function realOf(path: string): Promise<string | undefined> {
	let current = resolve(path);
	const missing: string[] = [];
	for (;;) {
		try {
			return join(await realpath(current), ...missing);
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
			// The name exists but its real path does not: a link that points to nothing.
			const named = await lstat(current).then(
				() => true,
				() => false,
			);
			if (named) return undefined;
			const parent = dirname(current);
			if (parent === current) return undefined;
			missing.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * The absolute paths a file tool may open for `path`, as pi-durable's tools resolve it: a leading `@` dropped, odd
 * spaces made plain, `~` and relative paths by the execution env. `read` also tries a few spellings of the name.
 */
async function candidates(path: string, api: ToolExecutionApi, context: Context): Promise<string[] | undefined> {
	const plain = path.replace(UNICODE_SPACES, " ");
	const absolute = await api.env?.absolutePath(plain.startsWith("@") ? plain.slice(1) : plain, context);
	if (absolute === undefined || !absolute.ok) return undefined;
	const value = absolute.value;
	return [
		...new Set([
			value,
			value.replace(/ (AM|PM)\./gi, "\u202F$1."),
			value.normalize("NFD"),
			value.replace(/'/g, "\u2019"),
			value.normalize("NFD").replace(/'/g, "\u2019"),
		]),
	];
}

/**
 * A file tool that runs only when its `path` argument stays in `roots`: a path outside, also through a symlink or
 * `..`, is a tool error the model can read.
 */
export function guardTool(tool: ToolRegistration, roots: readonly string[]): ToolRegistration {
	return {
		...tool,
		execute: async (args, api, context): Promise<ToolExecutionResult> => {
			const path = (args as { path?: unknown } | undefined)?.path;
			if (typeof path !== "string") return failure("A path is required.");
			const paths = await candidates(path, api, context);
			const checked = paths === undefined ? [] : await Promise.all(paths.map((each) => realInside(each, roots)));
			if (paths === undefined || checked.includes(undefined)) return failure(outsideText(path));
			return tool.execute(args, api, context);
		},
	};
}

function failure(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }], isError: true };
}
