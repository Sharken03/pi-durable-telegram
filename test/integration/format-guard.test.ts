import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { CACHE_DIR } from "../../src/agent/open.ts";
import { CHAT, newFaux, startTestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastToolResult, observe, textOf, toolCall } from "../helpers/faux-steps.ts";
import { animatedGifBytes, pngBytes } from "../helpers/images.ts";
import { fakePrograms } from "../helpers/programs.ts";
import { textUpdate } from "../helpers/updates.ts";
import { docx, para } from "../helpers/zip.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Seen = { isError: boolean; text: string };

function inspect(messages: readonly Message[]): Seen {
	const result = lastToolResult(messages);
	return { isError: result?.isError === true, text: textOf(result) };
}

/** The start of a HEIC file: an `ftyp` box with the heic brand. */
function heic(): Buffer {
	const box = Buffer.alloc(84);
	box.writeUInt32BE(20, 0);
	box.write("ftypheic\0\0\0\0mif1", 4, "latin1");
	return box;
}

test("format guard: PDF, HEIC, Office, GIF and cache paths outside the workdir are refused before programs run", async () => {
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const log = join(dir, "programs.log");
	const logger = (name: string) => `echo "${name} $@" >> ${log}`;
	const bin = await fakePrograms(join(dir, "bin"), {
		pdfinfo: logger("pdfinfo"),
		pdftotext: logger("pdftotext"),
		pdftoppm: logger("pdftoppm"),
		"heif-dec": logger("heif-dec"),
	});
	const outside = join(dir, "outside");
	await mkdir(outside, { recursive: true });
	await writeFile(join(outside, "scan.pdf"), Buffer.from("%PDF-1.7\n"));
	await writeFile(join(outside, "photo.heic"), heic());
	await writeFile(join(outside, "notes.docx"), docx(para("secret")));
	await writeFile(join(outside, "dance.gif"), animatedGifBytes(2));
	const cache = join(dir, "data", CACHE_DIR);
	await mkdir(cache, { recursive: true });
	await writeFile(join(cache, "page.png"), pngBytes(8, 8));
	const work = join(dir, "work");
	await mkdir(work, { recursive: true });
	await symlink(join(outside, "scan.pdf"), join(work, "link.pdf"));
	await symlink(join(outside, "photo.heic"), join(work, "link.heic"));
	await symlink(join(outside, "notes.docx"), join(work, "link.docx"));

	const calls = [
		toolCall("read", { path: join(outside, "scan.pdf") }),
		toolCall("read", { path: "../outside/photo.heic" }),
		toolCall("read", { path: join(outside, "notes.docx") }),
		toolCall("read", { path: join(outside, "dance.gif") }),
		toolCall("read", { path: "link.pdf" }),
		toolCall("read", { path: "link.heic" }),
		toolCall("read", { path: "link.docx" }),
		toolCall("read", { path: join(cache, "page.png") }),
		toolCall("write", { path: join(cache, "page.png"), content: "x" }),
		toolCall("telegram_send_file", { path: join(outside, "dance.gif") }),
	];
	const faux = newFaux();
	const seen: Seen[] = [];
	const step = (next: ReturnType<typeof toolCall>) => observe((messages) => seen.push(inspect(messages)), next);
	const [first, ...rest] = calls;
	assert.ok(first !== undefined);
	faux.setResponses([first, ...rest.map(step), step(fauxAssistantMessage("refused"))]);
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir, faux, port, deps: { programPath: bin } });
	cleanups.push(() => t.close());
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "read them"));
	await waitFor(() => port.textsIn(CHAT).includes("refused"));

	assert.equal(seen.length, calls.length);
	for (const [index, each] of seen.entries()) {
		assert.equal(each.isError, true, `call ${index} is refused`);
		assert.match(each.text, /^Path is outside the working directory: /, `call ${index}`);
	}
	assert.equal(existsSync(log), false, "no program ran");
	assert.equal(port.created(CHAT).filter((m) => m.kind !== "text").length, 0, "nothing was sent");
});
