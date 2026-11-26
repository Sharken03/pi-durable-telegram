import { stat } from "node:fs/promises";
import { join } from "node:path";
import { ProgramError, type ProgramPath, runProgram } from "../../media/programs.ts";
import { cachePath, type FileCache, inWorkDir, isCached, type SourceId, store } from "./file-cache.ts";
import type { ImageMime } from "./image-probe.ts";

/** At most this many pages per read call, as in Claude Code's Read. */
export const MAX_PAGES_PER_READ = 20;
/** Text per read call; 2-byte characters still stay under the tool's 50 KB output limit. */
export const MAX_PDF_TEXT_CHARS = 24_000;
const MAX_PDF_TEXT_LINES = 1_500;
/** Scanned pages rendered per call: as many images as one model request shows. */
export const MAX_RENDERED_PAGES = 4;
/** A page with fewer visible characters is taken as a scan without a text layer. */
const SCAN_CHARS = 25;
const RENDER_DPI = 120;
/** The long side of a rendered page stays at or below this many pixels (a large page gets a lower dpi). */
const RENDER_MAX_PIXELS = 2000;
const TEXT_OUTPUT_BYTES = 8 * 1024 * 1024;
const INFO_OUTPUT_BYTES = 64 * 1024;

export type PdfInfo = {
	readonly pages: number;
	readonly title?: string;
	readonly author?: string;
	/** Width and height of the first page in points (1/72 inch). */
	readonly pageSize?: { readonly width: number; readonly height: number };
};

/** The fields of `pdfinfo` output the read tool uses; `pages` is 0 when the output has none. */
export function parsePdfInfo(output: string): PdfInfo {
	const fields = new Map<string, string>();
	for (const line of output.split("\n")) {
		const colon = line.indexOf(":");
		if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	const size = /^([\d.]+) x ([\d.]+) pts/.exec(fields.get("Page size") ?? "");
	const title = fields.get("Title") ?? "";
	const author = fields.get("Author") ?? "";
	return {
		pages: Number(fields.get("Pages") ?? 0) || 0,
		...(title === "" ? {} : { title }),
		...(author === "" ? {} : { author }),
		...(size === null ? {} : { pageSize: { width: Number(size[1]), height: Number(size[2]) } }),
	};
}

export type PageRange = { readonly first: number; readonly last: number; readonly asked?: string };

/**
 * The pages to read: `spec` is "3", "3-5" or "3-" (1-based, inclusive), capped at `MAX_PAGES_PER_READ` pages and at
 * the last page. Without `spec`: the first pages. Returns an English error text for a bad spec.
 */
export function parsePages(spec: string | undefined, total: number): PageRange | string {
	if (spec === undefined || spec.trim() === "") return { first: 1, last: Math.min(total, MAX_PAGES_PER_READ) };
	const match = /^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$/.exec(spec);
	if (match === null) return `pages must be a page or a range such as "3" or "3-5", not ${JSON.stringify(spec)}`;
	const first = Number(match[1]);
	const end = match[2] === undefined ? first : match[2] === "" ? total : Number(match[2]);
	if (first < 1 || end < first) return `pages ${JSON.stringify(spec)} is not a valid range`;
	if (first > total) return `the PDF has ${plural(total, "page")}; pages ${JSON.stringify(spec)} is past the end`;
	return { first, last: Math.min(end, total, first + MAX_PAGES_PER_READ - 1), asked: spec.trim() };
}

export type RenderedPage = { readonly page: number; readonly path: string; readonly mime: ImageMime };
export type PdfRead = { readonly text: string; readonly renders: readonly RenderedPage[] };

export type PdfDeps = {
	readonly programs: ProgramPath;
	readonly cache: FileCache;
	/** Largest image file the model takes; a larger PNG render is made again as JPEG. */
	readonly maxImageBytes: number;
	/** Whether scanned pages are rendered (the model can see images). */
	readonly render: boolean;
	readonly signal?: AbortSignal;
};

/**
 * Read a PDF: a summary from pdfinfo, then the text of the pages in `pages` (pdftotext), capped at
 * `MAX_PDF_TEXT_CHARS`. Pages without a text layer are rendered one at a time with pdftoppm into the file cache.
 * Throws `ProgramError` when a program is missing or fails, and returns an error text for a bad `pages` value.
 */
export async function readPdf(source: SourceId, pages: string | undefined, deps: PdfDeps): Promise<PdfRead | string> {
	const info = parsePdfInfo(await pdfText(deps, "pdfinfo", [source.path], INFO_OUTPUT_BYTES));
	if (info.pages === 0) return "pdfinfo found no pages in this PDF";
	const range = parsePages(pages, info.pages);
	if (typeof range === "string") return range;
	const args = ["-f", String(range.first), "-l", String(range.last), "-enc", "UTF-8", "-eol", "unix", source.path, "-"];
	const pageTexts = (await pdfText(deps, "pdftotext", args, TEXT_OUTPUT_BYTES)).split("\f");
	const lines = [summary(source.path, info, range)];
	const renders: RenderedPage[] = [];
	let budget = { chars: MAX_PDF_TEXT_CHARS, lines: MAX_PDF_TEXT_LINES };
	for (let page = range.first; page <= range.last; page += 1) {
		const text = (pageTexts[page - range.first] ?? "").trim();
		if (visibleChars(text) < SCAN_CHARS) {
			lines.push("", `--- Page ${page}: ${await scanNote(page, source, info, deps, renders)} ---`);
			if (text !== "") lines.push(text);
			continue;
		}
		const cut = fit(text, budget);
		lines.push("", `--- Page ${page} ---`, cut.text);
		budget = cut.left;
		if (cut.cut) {
			const limit = `${MAX_PDF_TEXT_CHARS}-character limit`;
			lines.push("", `[Text stops in page ${page} at the ${limit}. ${next(page, info)}]`);
			return { text: lines.join("\n"), renders };
		}
	}
	if (range.last < info.pages) {
		lines.push("", `[Pages ${range.last + 1}-${info.pages} are not shown. ${next(range.last + 1, info)}]`);
	}
	return { text: lines.join("\n"), renders };
}

function summary(path: string, info: PdfInfo, range: PageRange): string {
	const parts = [plural(info.pages, "page")];
	if (info.title !== undefined) parts.push(`title ${JSON.stringify(info.title)}`);
	if (info.author !== undefined) parts.push(`author ${JSON.stringify(info.author)}`);
	const asked = range.asked === undefined ? "" : ` (asked for ${JSON.stringify(range.asked)})`;
	return `PDF ${path}: ${parts.join(", ")}. Showing pages ${range.first}-${range.last}${asked}.`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function next(page: number, info: PdfInfo): string {
	const last = Math.min(info.pages, page + MAX_PAGES_PER_READ - 1);
	return `Read on with pages: "${page}-${last}" (at most ${MAX_PAGES_PER_READ} pages per call).`;
}

function visibleChars(text: string): number {
	return text.replace(/\s+/g, "").length;
}

type Budget = { readonly chars: number; readonly lines: number };

/** The part of `text` that fits the budget, cut at a line end where possible. */
function fit(text: string, budget: Budget): { text: string; cut: boolean; left: Budget } {
	const lines = text.split("\n");
	if (text.length <= budget.chars && lines.length <= budget.lines) {
		return { text, cut: false, left: { chars: budget.chars - text.length, lines: budget.lines - lines.length } };
	}
	let kept = lines.slice(0, budget.lines).join("\n").slice(0, budget.chars);
	const lineEnd = kept.lastIndexOf("\n");
	if (lineEnd > kept.length / 2) kept = kept.slice(0, lineEnd);
	return { text: kept, cut: true, left: { chars: 0, lines: 0 } };
}

/** The header note of a page without text, rendering it when the model can see it and the render limit allows. */
async function scanNote(
	page: number,
	source: SourceId,
	info: PdfInfo,
	deps: PdfDeps,
	renders: RenderedPage[],
): Promise<string> {
	const scan = "no text layer (a scan or a picture)";
	if (!deps.render) return `${scan}; this model cannot view images`;
	if (renders.length >= MAX_RENDERED_PAGES) {
		return `${scan}; not rendered, at most ${MAX_RENDERED_PAGES} pages per call are. Read it with pages: "${page}"`;
	}
	try {
		renders.push(await renderPage(page, source, info, deps));
		return `${scan}; rendered as image ${renders.length} of this result`;
	} catch (error) {
		if (!(error instanceof ProgramError)) throw error;
		return `${scan}; rendering failed: ${error.message}`;
	}
}

/** Render one page to PNG (JPEG when the PNG is too large for the model) into the file cache, or reuse it. */
async function renderPage(page: number, source: SourceId, info: PdfInfo, deps: PdfDeps): Promise<RenderedPage> {
	for (const format of ["png", "jpg"] as const) {
		const target = cachePath(deps.cache, source, `page-${page}.${format}`);
		const mime = format === "png" ? "image/png" : "image/jpeg";
		if (!(await isCached(target))) await renderInto(page, source.path, dpi(info), format, target, deps);
		const size = (await stat(target)).size;
		if (size <= deps.maxImageBytes || format === "jpg") return { page, path: target, mime };
	}
	throw new Error("unreachable: the JPEG render always returns");
}

function dpi(info: PdfInfo): number {
	const longSide = Math.max(info.pageSize?.width ?? 0, info.pageSize?.height ?? 0);
	if (longSide <= 0) return RENDER_DPI;
	return Math.max(30, Math.min(RENDER_DPI, Math.floor((RENDER_MAX_PIXELS * 72) / longSide)));
}

async function renderInto(
	page: number,
	file: string,
	resolution: number,
	format: "png" | "jpg",
	target: string,
	deps: PdfDeps,
): Promise<void> {
	await inWorkDir(deps.cache, async (dir) => {
		const prefix = join(dir, "page");
		const kind = format === "png" ? ["-png"] : ["-jpeg", "-jpegopt", "quality=80"];
		const pageArgs = ["-f", String(page), "-l", String(page), "-r", String(resolution), "-singlefile"];
		await runProgram(deps.programs, "pdftoppm", [...pageArgs, ...kind, file, prefix], {
			maxOutputBytes: INFO_OUTPUT_BYTES,
			...(deps.signal === undefined ? {} : { signal: deps.signal }),
		});
		await store(deps.cache, `${prefix}.${format}`, target);
	});
}

async function pdfText(
	deps: PdfDeps,
	name: "pdfinfo" | "pdftotext",
	args: readonly string[],
	maxOutputBytes: number,
): Promise<string> {
	const result = await runProgram(deps.programs, name, args, {
		maxOutputBytes,
		...(deps.signal === undefined ? {} : { signal: deps.signal }),
	});
	return result.stdout.toString("utf8");
}
