import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { buildSafeEnv } from "../agent/tools/safe-env.ts";

/**
 * Fixed host programs the file tools may run. The model never chooses a program or its arguments: tools call
 * `runProgram` with a name from this list and arguments they build themselves.
 */
export type ProgramName = "pdfinfo" | "pdftotext" | "pdftoppm" | "heif-dec";

const PACKAGES: Record<ProgramName, string> = {
	pdfinfo: "poppler-utils",
	pdftotext: "poppler-utils",
	pdftoppm: "poppler-utils",
	"heif-dec": "libheif-examples",
};

/** Where the tools look for programs: a PATH-like list of directories. Tests point it at fake programs. */
export type ProgramPath = { readonly path: string };

export const DEFAULT_TIMEOUT_MS = 60_000;
const STDERR_BYTES = 4096;

export type RunOptions = {
	readonly timeoutMs?: number;
	/** Stdout beyond this many bytes stops the program; the result then has `truncated: true`. */
	readonly maxOutputBytes: number;
	readonly signal?: AbortSignal;
};

export type RunResult = { readonly stdout: Buffer; readonly truncated: boolean };

/** A program that is not installed, failed, timed out or was stopped. The message is for the model. */
export class ProgramError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProgramError";
	}
}

/** The first executable `name` in the directories of `path`, or undefined. */
export async function findProgram(name: string, path: string): Promise<string | undefined> {
	for (const dir of path.split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, name);
		const found = await access(candidate, constants.X_OK).then(
			() => true,
			() => false,
		);
		if (found) return candidate;
	}
	return undefined;
}

let nicePath: Promise<string | undefined> | undefined;

/** `nice` from the process PATH, looked up once; programs run without it when it is missing. */
function niceProgram(): Promise<string | undefined> {
	nicePath ??= findProgram("nice", process.env.PATH ?? "/usr/bin:/bin");
	return nicePath;
}

/**
 * Run `name` with `args` through `nice -n 10`, with execFile (no shell), a timeout, a stdout limit and an environment
 * without secrets. Resolves with stdout; throws `ProgramError` with a short English reason.
 */
export async function runProgram(
	programs: ProgramPath,
	name: ProgramName,
	args: readonly string[],
	options: RunOptions,
): Promise<RunResult> {
	const program = await findProgram(name, programs.path);
	if (program === undefined) {
		throw new ProgramError(`${name} is not installed on this host (Debian package ${PACKAGES[name]}).`);
	}
	const nice = await niceProgram();
	const file = nice ?? program;
	const argv = nice === undefined ? args : ["-n", "10", program, ...args];
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		execFile(
			file,
			argv,
			{
				encoding: "buffer",
				timeout: timeoutMs,
				killSignal: "SIGKILL",
				maxBuffer: options.maxOutputBytes,
				env: buildSafeEnv(process.env),
				windowsHide: true,
				...(options.signal === undefined ? {} : { signal: options.signal }),
			},
			(error, stdout, stderr) => {
				if (error === null) return resolve({ stdout, truncated: false });
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ stdout, truncated: true });
				reject(new ProgramError(failureText(name, error, stderr, timeoutMs)));
			},
		);
	});
}

function failureText(name: string, error: Error, stderr: Buffer, timeoutMs: number): string {
	const failed = error as Error & { killed?: boolean; signal?: string | null; code?: unknown };
	if (failed.name === "AbortError") return `${name} was stopped.`;
	if (failed.killed === true || failed.signal === "SIGKILL")
		return `${name} took longer than ${timeoutMs / 1000} s and was stopped.`;
	const detail = stderr.subarray(0, STDERR_BYTES).toString("utf8").trim().split("\n")[0] ?? "";
	const exit = typeof failed.code === "number" ? ` (exit ${failed.code})` : "";
	return `${name} failed${exit}${detail === "" ? "." : `: ${detail}`}`;
}
