import assert from "node:assert/strict";
import { getPriority } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProgramError, runProgram } from "../../src/media/programs.ts";
import { tempDir } from "../helpers/agent.ts";
import { fakePrograms } from "../helpers/programs.ts";

test("programs: a fixed program runs without a shell and returns its stdout", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const path = await fakePrograms(join(dir, "bin"), { pdfinfo: 'printf "%s|" "$@"' });
		const result = await runProgram({ path }, "pdfinfo", ["a b", "$(touch x)", "-"], { maxOutputBytes: 1000 });
		assert.equal(result.stdout.toString(), "a b|$(touch x)|-|");
		assert.equal(result.truncated, false);
	} finally {
		await cleanup();
	}
});

test("programs: a missing program names its Debian package", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		await assert.rejects(
			runProgram({ path: join(dir, "none") }, "heif-dec", [], { maxOutputBytes: 10 }),
			(error: unknown) =>
				error instanceof ProgramError && /heif-dec is not installed .*libheif-examples/.test(error.message),
		);
	} finally {
		await cleanup();
	}
});

test("programs: failure, timeout and output limit", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const path = await fakePrograms(join(dir, "bin"), {
			pdftotext: 'echo "Syntax Error: broken xref" >&2; echo more >&2; exit 3',
			pdftoppm: "sleep 5",
			pdfinfo: "i=0; while [ $i -lt 2000 ]; do echo 0123456789; i=$((i+1)); done",
		});
		await assert.rejects(
			runProgram({ path }, "pdftotext", [], { maxOutputBytes: 100 }),
			(error: unknown) =>
				error instanceof ProgramError && error.message === "pdftotext failed (exit 3): Syntax Error: broken xref",
		);
		await assert.rejects(
			runProgram({ path }, "pdftoppm", [], { maxOutputBytes: 100, timeoutMs: 200 }),
			(error: unknown) => error instanceof ProgramError && /pdftoppm took longer than 0.2 s/.test(error.message),
		);
		const big = await runProgram({ path }, "pdfinfo", [], { maxOutputBytes: 1000 });
		assert.equal(big.truncated, true);
		assert.ok(big.stdout.length <= 1000);
	} finally {
		await cleanup();
	}
});

test("programs: the child gets no secrets and runs at a lower priority", async () => {
	const { dir, cleanup } = await tempDir();
	process.env.SOME_API_KEY = "secret-value";
	try {
		const path = await fakePrograms(join(dir, "bin"), {
			pdfinfo: 'echo "key=${SOME_API_KEY:-none}"; cut -d" " -f19 /proc/$$/stat',
		});
		const result = await runProgram({ path }, "pdfinfo", [], { maxOutputBytes: 1000 });
		const [key, nice] = result.stdout.toString().trim().split("\n");
		assert.equal(key, "key=none");
		assert.equal(Number(nice), Math.min(19, getPriority() + 10), "nice -n 10 adds 10 to the niceness");
	} finally {
		delete process.env.SOME_API_KEY;
		await cleanup();
	}
});
