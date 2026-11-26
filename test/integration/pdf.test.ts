import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type FauxProviderHandle, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { CACHE_DIR } from "../../src/agent/open.ts";
import { MAX_PAGES_PER_READ, parsePages, parsePdfInfo } from "../../src/agent/tools/pdf-read.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastToolResult, observe, textOf, toolCall } from "../helpers/faux-steps.ts";
import { pngBytes } from "../helpers/images.ts";
import { fakePrograms } from "../helpers/programs.ts";
import { textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PDFINFO = `cat <<'INFO'
Title:          Annual report
Author:         Kontor 1
Pages:          30
Encrypted:      no
Page size:      595.276 x 841.89 pts (A4)
INFO`;

/** Pages 2 and 4-9 have no text (scans); every other page has a line of text. */
const PDFTOTEXT = `p=$2
while [ "$p" -le "$4" ]; do
  case $p in
    2|4|5|6|7|8|9) printf ' \\f' ;;
    *) printf 'This is the text of page %s, long enough to count.\\n\\f' "$p" ;;
  esac
  p=$((p+1))
done`;

type Setup = { t: TestAgent; port: FakeTelegram; work: string; bin: string; data: string };

async function setup(faux: FauxProviderHandle, scripts: Record<string, string>): Promise<Setup> {
	const { dir, cleanup } = await tempDir();
	const bin = join(dir, "bin");
	await writeFile(join(dir, "page.png"), pngBytes(40, 56));
	const pdftoppm = `echo "$@" >> ${join(dir, "pdftoppm.log")}
for last; do :; done
cp ${join(dir, "page.png")} "$last.png"`;
	await fakePrograms(bin, { pdftoppm, ...scripts });
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir, faux, port, deps: { programPath: bin } });
	cleanups.push(cleanup, () => t.close());
	return { t, port, work: join(dir, "work"), bin: dir, data: join(dir, "data") };
}

type Seen = { isError: boolean; text: string; images: string[] };

function inspect(messages: readonly Message[]): Seen {
	const result = lastToolResult(messages);
	const images = (result?.content ?? []).flatMap((part) => (part.type === "image" ? [part.mimeType] : []));
	return { isError: result?.isError === true, text: textOf(result), images };
}

const PDF = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n";

test("pdf: pdfinfo fields and page ranges", () => {
	const info = parsePdfInfo("Title:   A: B\nPages:          12\nPage size:      612 x 792 pts (letter)\nAuthor:\n");
	assert.deepEqual(info, { pages: 12, title: "A: B", pageSize: { width: 612, height: 792 } });
	assert.deepEqual(parsePages(undefined, 50), { first: 1, last: MAX_PAGES_PER_READ });
	assert.deepEqual(parsePages(" 3-5 ", 50), { first: 3, last: 5, asked: "3-5" });
	assert.deepEqual(parsePages("7", 50), { first: 7, last: 7, asked: "7" });
	assert.deepEqual(parsePages("40-", 50), { first: 40, last: 50, asked: "40-" });
	assert.deepEqual(parsePages("1-100", 200), { first: 1, last: 20, asked: "1-100" });
	assert.match(String(parsePages("60", 50)), /has 50 pages; pages "60" is past the end/);
	assert.match(String(parsePages("5-3", 50)), /not a valid range/);
	assert.match(String(parsePages("1,3", 50)), /a page or a range/);
});

test("pdf: read gives a summary, page text and scanned pages as images; programs get fixed arguments", async () => {
	const faux = newFaux();
	const seen: Seen[] = [];
	faux.setResponses([
		toolCall("read", { path: "report.pdf" }),
		observe((messages) => seen.push(inspect(messages)), toolCall("read", { path: "report.pdf", pages: "21-30" })),
		observe((messages) => seen.push(inspect(messages)), fauxAssistantMessage("read it")),
	]);
	const { t, port, work, bin, data } = await setup(faux, { pdfinfo: PDFINFO, pdftotext: PDFTOTEXT });
	await writeFile(join(work, "report.pdf"), PDF);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "read the report"));
	await waitFor(() => port.textsIn(CHAT).includes("read it"));
	const first = seen[0];
	assert.equal(first?.isError, false);
	assert.match(first?.text ?? "", /^PDF .*report\.pdf: 30 pages, title "Annual report", author "Kontor 1"\. Showing pages 1-20\./);
	assert.match(first?.text ?? "", /--- Page 1 ---\nThis is the text of page 1, long enough to count\./);
	assert.match(first?.text ?? "", /--- Page 2: no text layer \(a scan or a picture\); rendered as image 1 of this result ---/);
	assert.match(first?.text ?? "", /--- Page 8: .*not rendered, at most 4 pages per call are\. Read it with pages: "8" ---/);
	assert.match(first?.text ?? "", /\[Pages 21-30 are not shown\. Read on with pages: "21-30"/);
	assert.deepEqual(first?.images, ["image/png", "image/png", "image/png", "image/png"]);
	const log = (await readFile(join(bin, "pdftoppm.log"), "utf8")).trim().split("\n");
	assert.equal(log.length, 4, "one pdftoppm run per rendered page");
	assert.match(log[0] ?? "", /^-f 2 -l 2 -r 120 -singlefile -png \/.*report\.pdf \/.*\/work-[^/]+\/page$/);
	const cache = await readdir(join(data, CACHE_DIR));
	assert.equal(cache.filter((name) => name.endsWith(".png")).length, 4);
	assert.deepEqual(
		cache.filter((name) => name.startsWith("work-")),
		[],
		"work folders are removed",
	);
	const second = seen[1];
	assert.match(second?.text ?? "", /Showing pages 21-30 \(asked for "21-30"\)\./);
	assert.match(second?.text ?? "", /--- Page 30 ---/);
	assert.doesNotMatch(second?.text ?? "", /are not shown/);
	assert.deepEqual(second?.images, [], "the newest images are the first result's; this one has none");
});

test("pdf: a text-only model gets the text and no renders; a bad range and a missing program are errors", async () => {
	const faux = newFaux({ models: [{ id: "faux-1", input: ["text"] }] });
	const seen: Seen[] = [];
	faux.setResponses([
		toolCall("read", { path: "report.pdf", pages: "1-3" }),
		observe((messages) => seen.push(inspect(messages)), toolCall("read", { path: "report.pdf", pages: "99" })),
		observe((messages) => seen.push(inspect(messages)), toolCall("read", { path: "broken.pdf" })),
		observe((messages) => seen.push(inspect(messages)), fauxAssistantMessage("done")),
	]);
	const { t, port, work, bin } = await setup(faux, {
		pdfinfo: `case "$1" in *broken*) echo "Syntax Error: Couldn't find trailer dictionary" >&2; exit 1;; esac\n${PDFINFO}`,
	});
	await writeFile(join(work, "report.pdf"), PDF);
	await writeFile(join(work, "broken.pdf"), PDF);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "read"));
	await waitFor(() => port.textsIn(CHAT).includes("done"));
	assert.equal(seen[0]?.isError, true);
	assert.match(seen[0]?.text ?? "", /Cannot read the PDF .*report\.pdf: pdftotext is not installed on this host \(Debian package poppler-utils\)/);
	assert.equal(seen[1]?.isError, true);
	assert.match(seen[1]?.text ?? "", /the PDF has 30 pages; pages "99" is past the end/);
	assert.equal(seen[2]?.isError, true);
	assert.match(seen[2]?.text ?? "", /pdfinfo failed \(exit 1\): Syntax Error: Couldn't find trailer dictionary/);
	await fakePrograms(join(bin, "bin"), { pdftotext: PDFTOTEXT });
	faux.appendResponses([
		toolCall("read", { path: "report.pdf", pages: "1-3" }),
		observe((messages) => seen.push(inspect(messages)), fauxAssistantMessage("again")),
	]);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "again"));
	await waitFor(() => port.textsIn(CHAT).includes("again"));
	assert.equal(seen[3]?.isError, false);
	assert.match(seen[3]?.text ?? "", /--- Page 2: no text layer \(a scan or a picture\); this model cannot view images ---/);
	assert.deepEqual(seen[3]?.images, []);
});
