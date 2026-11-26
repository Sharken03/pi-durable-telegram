import { posix } from "node:path";
import { attribute, xmlTokens } from "../../media/xml.ts";
import { openZip, readEntry, type UnpackBudget, type ZipArchive } from "../../media/zip.ts";

/** XML unpacked per part and per read call: the caps that make a ZIP bomb harmless. */
export const MAX_PART_XML_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_XML_BYTES = 16 * 1024 * 1024;
/** Text per read call, as for PDF files. */
export const MAX_OFFICE_TEXT_CHARS = 24_000;
export const MAX_SHEET_ROWS = 2_000;
export const MAX_SHEET_COLUMNS = 50;

export type OfficeKind = "docx" | "xlsx" | "pptx";

const MAIN_PART: Readonly<Record<OfficeKind, string>> = {
	docx: "word/document.xml",
	xlsx: "xl/workbook.xml",
	pptx: "ppt/presentation.xml",
};

/** The Office format of a ZIP archive, from the parts it holds; undefined for any other ZIP file. */
export function officeKind(zip: ZipArchive): OfficeKind | undefined {
	return (Object.keys(MAIN_PART) as OfficeKind[]).find((kind) => zip.entries.has(MAIN_PART[kind]));
}

export type OfficeWindow = { readonly offset?: number; readonly limit?: number };

/**
 * A Word, Excel or PowerPoint file as Markdown: a summary line, then the lines in `window` (1-based `offset`, at most
 * `limit` lines), capped at `MAX_OFFICE_TEXT_CHARS`. Undefined when the ZIP file is not one of these. Throws
 * `ZipError` for a damaged archive.
 */
export async function readOffice(path: string, window: OfficeWindow = {}): Promise<string | undefined> {
	const zip = await openZip(path);
	const kind = officeKind(zip);
	if (kind === undefined) return undefined;
	const parts: Parts = { zip, budget: { left: MAX_TOTAL_XML_BYTES }, notes: [] };
	const converted = await CONVERTERS[kind](parts);
	return present(path, converted, parts.notes, window);
}

type Parts = { readonly zip: ZipArchive; readonly budget: UnpackBudget; readonly notes: string[] };
type Converted = { readonly label: string; readonly summary?: string; readonly lines: readonly string[] };

const CONVERTERS: Readonly<Record<OfficeKind, (parts: Parts) => Promise<Converted>>> = {
	docx: async (parts) => ({ label: "Word document", lines: docxLines((await xmlOf(parts, MAIN_PART.docx)) ?? "") }),
	xlsx: convertXlsx,
	pptx: convertPptx,
};

async function xmlOf(parts: Parts, name: string): Promise<string | undefined> {
	const unpacked = await readEntry(parts.zip, name, MAX_PART_XML_BYTES, parts.budget);
	if (unpacked === undefined) return undefined;
	if (unpacked.cut) {
		const caps = `${MAX_PART_XML_BYTES / 1_048_576} MB of XML per part, ${MAX_TOTAL_XML_BYTES / 1_048_576} MB per call`;
		parts.notes.push(`${name} is cut at the unpack limit (${caps}); the rest of it is not shown.`);
	}
	return new TextDecoder().decode(unpacked.bytes);
}

function present(path: string, converted: Converted, notes: readonly string[], window: OfficeWindow): string {
	const lines = tidy(converted.lines);
	const total = lines.length;
	const summary = converted.summary === undefined ? "" : `: ${converted.summary}`;
	const head = [`${converted.label} ${path}${summary}. Shown as Markdown, ${plural(total, "line")}.`];
	head.push(...notes.map((note) => `[${note}]`));
	if (total === 0) return [...head, "", "(no text)"].join("\n");
	const first = Math.max(1, Math.floor(window.offset ?? 1));
	if (first > total) return [...head, "", `[offset ${first} is past the end.]`].join("\n");
	const limit = window.limit === undefined ? total : Math.max(1, Math.floor(window.limit));
	const kept: string[] = [];
	let chars = 0;
	for (const line of lines.slice(first - 1, first - 1 + limit)) {
		if (kept.length > 0 && chars + line.length + 1 > MAX_OFFICE_TEXT_CHARS) break;
		kept.push(line.slice(0, MAX_OFFICE_TEXT_CHARS));
		chars += line.length + 1;
	}
	const last = first + kept.length - 1;
	const out = [...head, "", ...kept];
	if (last < total) out.push("", `[Lines ${first}-${last} of ${total} are shown. Read on with offset: ${last + 1}.]`);
	return out.join("\n");
}

/** One text line per entry (a paragraph with breaks becomes several), without blank runs at the ends or inside. */
function tidy(lines: readonly string[]): string[] {
	const out: string[] = [];
	for (const line of lines.flatMap((each) => each.split("\n"))) {
		if (line.trim() === "" && (out.length === 0 || out.at(-1) === "")) continue;
		out.push(line.trim() === "" ? "" : line);
	}
	while (out.at(-1) === "") out.pop();
	return out;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Rows as a Markdown table, the first row as the header. */
export function markdownTable(rows: readonly (readonly (string | undefined)[])[]): string[] {
	const width = Math.max(1, ...rows.map((row) => Math.min(row.length, MAX_SHEET_COLUMNS)));
	const line = (row: readonly (string | undefined)[]) =>
		`| ${Array.from({ length: width }, (_, index) => tableCell(row[index] ?? "")).join(" | ")} |`;
	return [line(rows[0] ?? []), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)];
}

function tableCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, "<br>").trim();
}

// Word

type Paragraph = { text: string; heading: number; list: boolean };
type Cell = { parts: string[]; span: number };
type Table = { rows: (string | undefined)[][]; cell: Cell | undefined };

const HEADING_STYLE = /^(?:heading|overskrift|berschrift|titre|kop|rubrik)\s*([1-6])$/i;

/** The body of `word/document.xml`: paragraphs as lines (headings and list items marked) and tables as tables. */
export function docxLines(xml: string): string[] {
	const lines: string[] = [];
	const paragraphs: Paragraph[] = [];
	const tables: Table[] = [];
	let inText = false;
	let tabStops = 0;
	const add = (text: string) => {
		const paragraph = paragraphs.at(-1);
		if (paragraph !== undefined) paragraph.text += text;
	};
	for (const token of xmlTokens(xml)) {
		if (token.kind === "text") {
			if (inText) add(token.text);
			continue;
		}
		const open = token.kind === "open";
		const starts = open && !token.empty;
		switch (token.name) {
			case "w:p":
				if (starts) paragraphs.push({ text: "", heading: 0, list: false });
				else endParagraph(open ? { text: "", heading: 0, list: false } : paragraphs.pop(), tables, lines);
				break;
			case "w:pStyle": {
				const paragraph = paragraphs.at(-1);
				const style = open ? (attribute(token.attributes, "w:val") ?? "") : "";
				const level = HEADING_STYLE.exec(style)?.[1];
				if (paragraph !== undefined && level !== undefined) paragraph.heading = Number(level);
				if (paragraph !== undefined && /^(title|titel)$/i.test(style)) paragraph.heading = 1;
				break;
			}
			case "w:numPr": {
				const paragraph = paragraphs.at(-1);
				if (open && paragraph !== undefined) paragraph.list = true;
				break;
			}
			case "w:t":
				inText = starts;
				break;
			case "w:tabs":
				tabStops += starts ? 1 : open ? 0 : -1;
				break;
			case "w:tab":
				if (open && tabStops === 0) add("\t");
				break;
			case "w:br":
			case "w:cr":
				if (open) add("\n");
				break;
			case "w:tbl":
				if (starts) tables.push({ rows: [], cell: undefined });
				else if (!open) endTable(tables, lines);
				break;
			case "w:tr":
				if (starts) tables.at(-1)?.rows.push([]);
				break;
			case "w:tc": {
				const table = tables.at(-1);
				if (table === undefined) break;
				if (starts) table.cell = { parts: [], span: 1 };
				else if (!open && table.cell !== undefined) {
					const row = table.rows.at(-1);
					row?.push(table.cell.parts.join("\n"), ...Array<string>(Math.max(0, table.cell.span - 1)).fill(""));
					table.cell = undefined;
				}
				break;
			}
			case "w:gridSpan": {
				const cell = tables.at(-1)?.cell;
				if (open && cell !== undefined) cell.span = Number(attribute(token.attributes, "w:val")) || 1;
				break;
			}
		}
	}
	return lines;
}

function endParagraph(paragraph: Paragraph | undefined, tables: readonly Table[], lines: string[]): void {
	if (paragraph === undefined) return;
	const text = paragraph.text.replace(/[ \t]+$/gm, "");
	const cell = tables.at(-1)?.cell;
	if (cell !== undefined) {
		if (text.trim() !== "") cell.parts.push(text.trim());
		return;
	}
	if (text.trim() === "") {
		lines.push("");
		return;
	}
	const prefix = paragraph.heading > 0 ? `${"#".repeat(paragraph.heading)} ` : paragraph.list ? "- " : "";
	lines.push(`${prefix}${text}`);
}

function endTable(tables: Table[], lines: string[]): void {
	const table = tables.pop();
	if (table === undefined || table.rows.length === 0) return;
	const outer = tables.at(-1)?.cell;
	if (outer !== undefined) {
		// A table inside a table cell becomes text in that cell.
		outer.parts.push(table.rows.map((row) => row.filter((cell) => cell !== "").join("; ")).join(" / "));
		return;
	}
	lines.push("", ...markdownTable(table.rows), "");
}

// Excel

type SheetRef = { readonly name: string; readonly relation: string; readonly hidden: boolean };

async function convertXlsx(parts: Parts): Promise<Converted> {
	const sheets = workbookSheets((await xmlOf(parts, MAIN_PART.xlsx)) ?? "");
	const targets = relationships((await xmlOf(parts, "xl/_rels/workbook.xml.rels")) ?? "", "xl");
	const shared = sharedStrings((await xmlOf(parts, "xl/sharedStrings.xml")) ?? "");
	const lines: string[] = [];
	for (const [index, sheet] of sheets.entries()) {
		lines.push(`## Sheet ${index + 1}: ${sheet.name}${sheet.hidden ? " (hidden)" : ""}`, "");
		const xml = await xmlOf(parts, targets.get(sheet.relation) ?? `xl/worksheets/sheet${index + 1}.xml`);
		const grid = xml === undefined ? undefined : sheetGrid(xml, shared);
		if (grid === undefined) lines.push("(this sheet is missing from the file)");
		else if (grid.rows.length === 0) lines.push("(empty)");
		else lines.push(...markdownTable(grid.rows));
		if (grid?.moreRows === true) {
			const size = grid.lastRow === undefined ? "" : `; the sheet goes to row ${grid.lastRow}`;
			lines.push("", `[Only the first ${MAX_SHEET_ROWS} rows are shown${size}.]`);
		}
		if (grid?.moreColumns === true) lines.push("", `[Only the first ${MAX_SHEET_COLUMNS} columns are shown.]`);
		lines.push("");
	}
	const names = sheets.map((sheet) => sheet.name).join(", ");
	const summary = `${plural(sheets.length, "sheet")}${sheets.length === 0 ? "" : ` (${names})`}; dates may show as day numbers (45000 is 2023-03-15)`;
	return { label: "Excel workbook", summary, lines };
}

function workbookSheets(xml: string): SheetRef[] {
	const sheets: SheetRef[] = [];
	for (const token of xmlTokens(xml)) {
		if (token.kind !== "open" || token.name !== "sheet") continue;
		const state = attribute(token.attributes, "state");
		sheets.push({
			name: attribute(token.attributes, "name") ?? `Sheet ${sheets.length + 1}`,
			relation: attribute(token.attributes, "r:id") ?? "",
			hidden: state === "hidden" || state === "veryHidden",
		});
	}
	return sheets;
}

/** Relationship ids to part names, for parts that live next to `base` (such as `xl`). */
function relationships(xml: string, base: string): Map<string, string> {
	const targets = new Map<string, string>();
	for (const token of xmlTokens(xml)) {
		if (token.kind !== "open" || token.name !== "Relationship") continue;
		const id = attribute(token.attributes, "Id");
		const target = attribute(token.attributes, "Target");
		if (id === undefined || target === undefined || attribute(token.attributes, "TargetMode") === "External") continue;
		targets.set(id, target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join(base, target)));
	}
	return targets;
}

function sharedStrings(xml: string): string[] {
	const strings: string[] = [];
	let current: string | undefined;
	let inText = false;
	let phonetic = 0;
	for (const token of xmlTokens(xml)) {
		if (token.kind === "text") {
			if (inText && phonetic === 0 && current !== undefined) current += token.text;
			continue;
		}
		const starts = token.kind === "open" && !token.empty;
		if (token.name === "si") {
			if (starts) current = "";
			else if (token.kind === "close") strings.push(current ?? "");
		} else if (token.name === "rPh") phonetic += starts ? 1 : token.kind === "close" ? -1 : 0;
		else if (token.name === "t") inText = starts;
	}
	return strings;
}

type Grid = { rows: (string | undefined)[][]; moreRows: boolean; moreColumns: boolean; lastRow?: number };

/** The cell values of a worksheet, up to `MAX_SHEET_ROWS` rows and `MAX_SHEET_COLUMNS` columns. */
export function sheetGrid(xml: string, shared: readonly string[]): Grid {
	const grid: Grid = { rows: [], moreRows: false, moreColumns: false };
	let row: (string | undefined)[] | undefined;
	let column = 0;
	let cell: { type: string; value: string } | undefined;
	let reading = false;
	for (const token of xmlTokens(xml)) {
		if (token.kind === "text") {
			if (reading && cell !== undefined) cell.value += token.text;
			continue;
		}
		const open = token.kind === "open";
		const starts = open && !token.empty;
		if (token.name === "dimension" && open) {
			const end = /(\d+)$/.exec(attribute(token.attributes, "ref") ?? "")?.[1];
			if (end !== undefined) grid.lastRow = Number(end);
		} else if (token.name === "row" && open) {
			if (grid.rows.length >= MAX_SHEET_ROWS) {
				grid.moreRows = true;
				break;
			}
			row = [];
			column = 0;
			grid.rows.push(row);
		} else if (token.name === "c" && open) {
			const ref = attribute(token.attributes, "r");
			if (ref !== undefined) column = columnIndex(ref);
			cell = { type: attribute(token.attributes, "t") ?? "n", value: "" };
			if (token.empty) {
				cell = undefined;
				column += 1;
			}
		} else if (token.name === "c" && !open && cell !== undefined) {
			const value = cellText(cell.type, cell.value, shared);
			if (value !== "" && column >= MAX_SHEET_COLUMNS) grid.moreColumns = true;
			else if (value !== "" && row !== undefined) row[column] = value;
			cell = undefined;
			column += 1;
		} else if (token.name === "v" || token.name === "t") {
			reading = starts;
		}
	}
	while (grid.rows.length > 0 && (grid.rows.at(-1) ?? []).every((value) => value === undefined)) grid.rows.pop();
	return grid;
}

function columnIndex(ref: string): number {
	let index = 0;
	for (const letter of /^[A-Z]+/.exec(ref)?.[0] ?? "") index = index * 26 + (letter.charCodeAt(0) - 64);
	return Math.max(0, index - 1);
}

function cellText(type: string, value: string, shared: readonly string[]): string {
	if (type === "s") return shared[Number(value)] ?? "";
	if (type === "b") return value === "1" ? "TRUE" : "FALSE";
	return value;
}

// PowerPoint

async function convertPptx(parts: Parts): Promise<Converted> {
	const presentation = (await xmlOf(parts, MAIN_PART.pptx)) ?? "";
	const targets = relationships((await xmlOf(parts, "ppt/_rels/presentation.xml.rels")) ?? "", "ppt");
	let slides = slideRelations(presentation).flatMap((relation) => targets.get(relation) ?? []);
	if (slides.length === 0) {
		const names = [...parts.zip.entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
		slides = names.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
	}
	const lines: string[] = [];
	for (const [index, name] of slides.entries()) {
		const text = slideLines((await xmlOf(parts, name)) ?? "");
		lines.push(`## Slide ${index + 1}`, "", ...(text.length === 0 ? ["(no text)"] : text), "");
	}
	return { label: "PowerPoint presentation", summary: plural(slides.length, "slide"), lines };
}

function slideRelations(xml: string): string[] {
	const relations: string[] = [];
	for (const token of xmlTokens(xml)) {
		if (token.kind !== "open" || token.name !== "p:sldId") continue;
		const relation = attribute(token.attributes, "r:id");
		if (relation !== undefined) relations.push(relation);
	}
	return relations;
}

/** The text of one slide: the title as a heading, other paragraphs as list items. */
export function slideLines(xml: string): string[] {
	const lines: string[] = [];
	let paragraph: string | undefined;
	let inText = false;
	let title = false;
	for (const token of xmlTokens(xml)) {
		if (token.kind === "text") {
			if (inText && paragraph !== undefined) paragraph += token.text;
			continue;
		}
		const open = token.kind === "open";
		const starts = open && !token.empty;
		if (token.name === "p:sp" && starts) title = false;
		else if (token.name === "p:ph" && open) title = /^(title|ctrTitle)$/.test(attribute(token.attributes, "type") ?? "");
		else if (token.name === "a:p" && starts) paragraph = "";
		else if (token.name === "a:p" && !open && paragraph !== undefined) {
			const text = paragraph.trim();
			if (text !== "") lines.push(`${title ? "### " : "- "}${text.replace(/\s*\n\s*/g, title ? " " : "\n  ")}`);
			paragraph = undefined;
		} else if (token.name === "a:t") inText = starts;
		else if (token.name === "a:br" && open && paragraph !== undefined) paragraph += "\n";
	}
	return lines;
}
