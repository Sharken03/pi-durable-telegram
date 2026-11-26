import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findProgram } from "../../src/media/programs.ts";

let shell: Promise<string> | undefined;

/** The absolute path of `sh`: a shebang with it works without `/bin/sh` and without a preloaded exec shim. */
function shellPath(): Promise<string> {
	shell ??= findProgram("sh", process.env.PATH ?? "/usr/bin:/bin").then((found) => {
		if (found === undefined) throw new Error("no sh in PATH");
		return found;
	});
	return shell;
}

/** Write fake programs (shell script bodies) into `dir`; returns `dir` for use as a program path. */
export async function fakePrograms(dir: string, scripts: Record<string, string>): Promise<string> {
	await mkdir(dir, { recursive: true });
	const sh = await shellPath();
	for (const [name, body] of Object.entries(scripts)) {
		const file = join(dir, name);
		await writeFile(file, `#!${sh}\n${body}\n`);
		await chmod(file, 0o755);
	}
	return dir;
}
