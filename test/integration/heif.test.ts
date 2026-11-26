import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type FauxProviderHandle, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { CACHE_DIR } from "../../src/agent/open.ts";
import { heifKind } from "../../src/agent/tools/heif-read.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastToolResult, lastUserText, observe, textOf, toolCall } from "../helpers/faux-steps.ts";
import { jpegBytes } from "../helpers/images.ts";
import { fakePrograms } from "../helpers/programs.ts";
import { documentUpdate, textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The start of a HEIF file: an `ftyp` box with a major brand and compatible brands. */
function heif(major: string, compatible: string[] = ["mif1"]): Buffer {
	const size = 16 + 4 * compatible.length;
	const box = Buffer.alloc(size + 64);
	box.writeUInt32BE(size, 0);
	box.write(`ftyp${major}`, 4, "latin1");
	compatible.forEach((brand, index) => box.write(brand, 16 + 4 * index, "latin1"));
	return box;
}

type Setup = { t: TestAgent; port: FakeTelegram; work: string; dir: string; data: string };

/**
 * A fake heif-dec that logs its arguments. At quality 85 it writes `big.jpg`, else `small.jpg`; for a file named
 * `burst*` it writes numbered files, as heif-dec does for a file with more than one image.
 */
const HEIF_DEC = (dir: string) => `echo "$@" >> ${join(dir, "heif-dec.log")}
for last; do :; done
case "$3" in
  *broken*) echo "No decoding plugin installed for this compression format (11.2)" >&2; exit 1 ;;
  *burst*) cp ${join(dir, "small.jpg")} "\${last%.jpg}-2.jpg"; cp ${join(dir, "small.jpg")} "\${last%.jpg}-1.jpg"; exit 0 ;;
esac
if [ "$2" = 85 ]; then cp ${join(dir, "big.jpg")} "$last"; else cp ${join(dir, "small.jpg")} "$last"; fi`;

async function setup(faux: FauxProviderHandle, withProgram = true): Promise<Setup> {
	const { dir, cleanup } = await tempDir();
	await writeFile(join(dir, "small.jpg"), jpegBytes(64, 48));
	await writeFile(join(dir, "big.jpg"), Buffer.concat([jpegBytes(4000, 3000), Buffer.alloc(6000)]));
	const bin = await fakePrograms(join(dir, "bin"), withProgram ? { "heif-dec": HEIF_DEC(dir) } : {});
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir, faux, port, deps: { programPath: bin } });
	cleanups.push(cleanup, () => t.close());
	return { t, port, work: join(dir, "work"), dir, data: join(dir, "data") };
}

type Seen = { isError: boolean; text: string; images: string[] };

function inspect(messages: readonly Message[]): Seen {
	const result = lastToolResult(messages);
	const images = (result?.content ?? []).flatMap((part) => (part.type === "image" ? [part.mimeType] : []));
	return { isError: result?.isError === true, text: textOf(result), images };
}

/** One model that takes images up to 3000 bytes (3/4 of its 4000-byte base64 limit). */
function smallLimit(): FauxProviderHandle {
	return newFaux({ models: [{ id: "faux-1", inputLimits: { images: { resize: { maxBytes: 4000 } } } }] });
}

test("heif: brands name the format", () => {
	assert.equal(heifKind("heic"), "HEIC");
	assert.equal(heifKind("heix"), "HEIC");
	assert.equal(heifKind("avif"), "AVIF");
	assert.equal(heifKind("mif1"), "HEIF");
});

test("heif: read converts HEIC to JPEG with heif-dec, lowers the quality to fit, and reuses the cache", async () => {
	const faux = smallLimit();
	const seen: Seen[] = [];
	faux.setResponses([
		toolCall("read", { path: "photo.heic" }),
		observe((messages) => seen.push(inspect(messages)), toolCall("read", { path: "photo.heic" })),
		observe((messages) => seen.push(inspect(messages)), toolCall("read", { path: "burst.heic" })),
		observe((messages) => seen.push(inspect(messages)), fauxAssistantMessage("seen")),
	]);
	const { t, port, work, dir, data } = await setup(faux);
	await writeFile(join(work, "photo.heic"), heif("heic"));
	await writeFile(join(work, "burst.heic"), heif("mif1", ["heic"]));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "look"));
	await waitFor(() => port.textsIn(CHAT).includes("seen"));
	assert.equal(seen[0]?.isError, false);
	assert.match(seen[0]?.text ?? "", /^Image \/.*photo\.heic \(HEIC, converted to JPEG: 64x48, 0\.0 MB\) is attached/);
	assert.deepEqual(seen[0]?.images, ["image/jpeg"]);
	assert.equal(seen[1]?.text, seen[0]?.text);
	assert.match(seen[2]?.text ?? "", /burst\.heic \(HEIF, converted to JPEG: 64x48/);
	const log = (await readFile(join(dir, "heif-dec.log"), "utf8")).trim().split("\n");
	assert.equal(log.length, 3, "q85 and q60 for the photo, nothing for the cached second read, q85 for the burst");
	assert.match(log[0] ?? "", /^-q 85 \/.*photo\.heic \/.*\/work-[^/]+\/out\.jpg$/);
	assert.match(log[1] ?? "", /^-q 60 /);
	const cache = await readdir(join(data, CACHE_DIR));
	assert.deepEqual(
		cache.filter((name) => name.startsWith("work-")),
		[],
		"work folders are removed",
	);
});

test("heif: a missing heif-dec, a failed decode and a photo too large at every quality are errors", async () => {
	const faux = smallLimit();
	const seen: Seen[] = [];
	faux.setResponses([
		toolCall("read", { path: "a.avif" }),
		observe((messages) => seen.push(inspect(messages)), fauxAssistantMessage("none")),
	]);
	const missing = await setup(faux, false);
	await writeFile(join(missing.work, "a.avif"), heif("avif"));
	await missing.t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "look"));
	await waitFor(() => missing.port.textsIn(CHAT).includes("none"));
	assert.equal(seen[0]?.isError, true);
	assert.match(
		seen[0]?.text ?? "",
		/^Cannot read the AVIF image \/.*a\.avif: heif-dec is not installed on this host \(Debian package libheif-examples\)\.$/,
	);

	const tiny = newFaux({ models: [{ id: "faux-1", inputLimits: { images: { resize: { maxBytes: 40 } } } }] });
	const later: Seen[] = [];
	tiny.setResponses([
		toolCall("read", { path: "broken.avif" }),
		observe((messages) => later.push(inspect(messages)), toolCall("read", { path: "photo.heic" })),
		observe((messages) => later.push(inspect(messages)), fauxAssistantMessage("errors")),
	]);
	const failing = await setup(tiny);
	await writeFile(join(failing.work, "broken.avif"), heif("avif"));
	await writeFile(join(failing.work, "photo.heic"), heif("heic"));
	await failing.t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "look"));
	await waitFor(() => failing.port.textsIn(CHAT).includes("errors"));
	assert.match(
		later[0]?.text ?? "",
		/^Cannot read the AVIF image .*broken\.avif: heif-dec failed \(exit 1\): No decoding plugin installed/,
	);
	assert.equal(later[1]?.isError, true);
	assert.match(later[1]?.text ?? "", /photo\.heic as JPEG: Image too large to view/);
	const log = (await readFile(join(failing.dir, "heif-dec.log"), "utf8")).trim().split("\n");
	assert.deepEqual(
		log.slice(1).map((line) => line.split(" ")[1]),
		["85", "60", "35"],
		"every quality is tried",
	);
});

test("heif: an incoming HEIC document is announced as an image to view", async () => {
	const faux = newFaux();
	let seen = "";
	faux.setResponses([
		observe((messages) => {
			seen = lastUserText(messages);
		}, fauxAssistantMessage("got it")),
	]);
	const { t, port } = await setup(faux);
	port.files.set("heic1", heif("heic"));
	await t.agent.channel.handleUpdate(documentUpdate(CHAT, 3, "heic1", "IMG_0001.HEIC", 100));
	await waitFor(() => port.textsIn(CHAT).includes("got it"));
	assert.match(seen, /document saved to inbox\/.*IMG_0001\.HEIC/);
	assert.match(seen, /View it with the read tool\./);
});
