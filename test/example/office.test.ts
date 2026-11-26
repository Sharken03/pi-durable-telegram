import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	docxLines,
	MAX_OFFICE_TEXT_CHARS,
	MAX_SHEET_ROWS,
	readOffice,
	sheetGrid,
	slideLines,
} from "../../src/agent/tools/office-read.ts";
import { attribute, decodeEntities, xmlTokens } from "../../src/media/xml.ts";
import { MAX_ZIP_ENTRIES, openZip, readEntry, ZipError } from "../../src/media/zip.ts";
import { tempDir } from "../helpers/agent.ts";
import { docx, makeZip, para } from "../helpers/zip.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function file(name: string, bytes: Buffer): Promise<string> {
	const { dir, cleanup } = await tempDir("pdt-office-");
	cleanups.push(cleanup);
	const path = join(dir, name);
	await writeFile(path, bytes);
	return path;
}

test("xml: tokens, attributes and entities; a cut document ends at its last whole token", () => {
	const tokens = [...xmlTokens('<?xml?><a x="1 &amp; 2"><b/>t &lt;3<![CDATA[<raw>]]></a><c y="cut')];
	assert.deepEqual(tokens, [
		{ kind: "open", name: "a", attributes: ' x="1 &amp; 2"', empty: false },
		{ kind: "open", name: "b", attributes: "", empty: true },
		{ kind: "text", text: "t <3" },
		{ kind: "text", text: "<raw>" },
		{ kind: "close", name: "a" },
	]);
	assert.equal(attribute(' w:val="Heading1" x=\'2\'', "w:val"), "Heading1");
	assert.equal(attribute(' x="1 &amp; 2"', "x"), "1 & 2");
	assert.equal(attribute(' xx="1"', "x"), undefined);
	assert.equal(decodeEntities("&#65;&#x1F600;&bogus;&#0;"), "A😀&bogus;&#0;");
});

test("zip: entries are read stored or deflated; caps stop a ZIP bomb; damage and encryption are errors", async () => {
	const bomb = Buffer.alloc(20 * 1024 * 1024);
	const path = await file("a.zip", makeZip({ "a.txt": "hello", "bomb.bin": bomb }));
	const zip = await openZip(path);
	assert.deepEqual([...zip.entries.keys()], ["a.txt", "bomb.bin"]);
	assert.ok((zip.entries.get("bomb.bin")?.compressedSize ?? 0) < 100_000, "20 MB of zeros pack small");
	const budget = { left: 1_500_000 };
	assert.equal((await readEntry(zip, "a.txt", 1000, budget))?.bytes.toString(), "hello");
	const unpacked = await readEntry(zip, "bomb.bin", 1_000_000, budget);
	assert.equal(unpacked?.cut, true);
	assert.equal(unpacked?.bytes.length, 1_000_000);
	assert.equal(budget.left, 1_500_000 - 5 - 1_000_000);
	const rest = await readEntry(zip, "bomb.bin", 1_000_000, budget);
	assert.equal(rest?.bytes.length, 1_500_000 - 5 - 1_000_000, "the budget caps the total");
	assert.equal(await readEntry(zip, "missing", 10, budget), undefined);
	const stored = await openZip(await file("s.zip", makeZip({ "s.txt": "stored text" }, { stored: true })));
	assert.deepEqual(await readEntry(stored, "s.txt", 6, { left: 100 }), { bytes: Buffer.from("stored"), cut: true });

	const fails = async (bytes: Buffer, pattern: RegExp, entry?: string) => {
		const attempt = async () => {
			const archive = await openZip(await file("x.zip", bytes));
			if (entry !== undefined) await readEntry(archive, entry, 100, { left: 100 });
		};
		await assert.rejects(attempt, (error: unknown) => error instanceof ZipError && pattern.test(error.message));
	};
	await fails(Buffer.from("PK\x03\x04 not a real zip"), /no ZIP directory found/);
	const many = Buffer.alloc(22);
	many.writeUInt32LE(0x06054b50, 0);
	many.writeUInt16LE(MAX_ZIP_ENTRIES + 1, 10);
	await fails(many, /holds 10001 files; at most 10000/);
	await fails(makeZip({ "e.xml": "x" }, { encrypted: true }), /e\.xml is encrypted/, "e.xml");
	await fails(makeZip({ "m.xml": "x" }, { method: 12 }), /compression method 12/, "m.xml");
	const damaged = makeZip({ "d.xml": "<a>some text</a>" });
	damaged.fill(0xff, 30 + 5, 30 + 10);
	await fails(damaged, /packed data is damaged/, "d.xml");
});

test("docx: headings, list items, tabs, breaks and tables become Markdown", () => {
	const table =
		"<w:tbl><w:tr><w:tc>" +
		para("Name") +
		"</w:tc><w:tc>" +
		para("Price | kr") +
		"</w:tc></w:tr><w:tr><w:tc><w:tcPr><w:gridSpan w:val=\"2\"/></w:tcPr>" +
		para("Total") +
		para("incl. VAT") +
		"</w:tc></w:tr><w:tr><w:tc><w:tbl><w:tr><w:tc>" +
		para("inner") +
		"</w:tc><w:tc>" +
		para("cell") +
		"</w:tc></w:tr></w:tbl></w:tc><w:tc>" +
		para("9") +
		"</w:tc></w:tr></w:tbl>";
	const body =
		para("Report", "Title") +
		para("Intro", "Overskrift2") +
		'<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr>' +
		"<w:r><w:t>one</w:t><w:tab/><w:t>two</w:t><w:br/><w:t>three</w:t></w:r>" +
		"<w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>" +
		"<w:p/><w:p/>" +
		para("Fish &amp; chips &lt;3") +
		table;
	assert.deepEqual(docxLines(body), [
		"# Report",
		"## Intro",
		"- one\ttwo\nthree",
		"",
		"",
		"Fish & chips <3",
		"",
		"| Name | Price \\| kr |",
		"| --- | --- |",
		"| Total<br>incl. VAT |  |",
		"| inner; cell | 9 |",
		"",
	]);
});

test("xlsx: sheets in workbook order with shared strings, gaps, types and a row cap", async () => {
	const rows = Array.from({ length: MAX_SHEET_ROWS + 5 }, (_, index) => `<row r="${index + 2}"><c r="A${index + 2}"><v>${index}</v></c></row>`);
	const path = await file(
		"book.xlsx",
		makeZip({
			"xl/workbook.xml":
				'<workbook><sheets><sheet name="Budget &amp; plan" sheetId="1" r:id="rId2"/>' +
				'<sheet name="Long" sheetId="2" state="hidden" r:id="rId1"/></sheets></workbook>',
			"xl/_rels/workbook.xml.rels":
				'<Relationships><Relationship Id="rId1" Target="worksheets/long.xml"/>' +
				'<Relationship Id="rId2" Target="/xl/worksheets/first.xml"/>' +
				'<Relationship Id="rId3" Target="https://example.com" TargetMode="External"/></Relationships>',
			"xl/sharedStrings.xml":
				"<sst><si><t>Item</t></si><si><r><t>Pri</t></r><r><t>ce</t></r><rPh><t>ignored</t></rPh></si><si><t>Tea</t></si></sst>",
			"xl/worksheets/first.xml":
				'<worksheet><dimension ref="A1:D3"/><sheetData>' +
				'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
				'<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="b"><v>1</v></c><c r="C2"><f>1+2</f><v>3.5</v></c>' +
				'<c r="D2" t="inlineStr"><is><t>note</t></is></c></row>' +
				'<row r="3"><c r="A3" s="1"/></row></sheetData></worksheet>',
			"xl/worksheets/long.xml": `<worksheet><dimension ref="A2:A${MAX_SHEET_ROWS + 6}"/><sheetData>${rows.join("")}</sheetData></worksheet>`,
		}),
	);
	const text = (await readOffice(path)) ?? "";
	const [head, ...rest] = text.split("\n");
	assert.match(head ?? "", /^Excel workbook .*book\.xlsx: 2 sheets \(Budget & plan, Long\); dates may show as day numbers/);
	assert.deepEqual(rest.slice(0, 7), [
		"",
		"## Sheet 1: Budget & plan",
		"",
		"| Item |  | Price |  |",
		"| --- | --- | --- | --- |",
		"| Tea | TRUE | 3.5 | note |",
		"",
	]);
	assert.match(text, /## Sheet 2: Long \(hidden\)\n\n\| 0 \|\n\| --- \|\n\| 1 \|/);
	assert.match(text, /\[Only the first 2000 rows are shown; the sheet goes to row 2006\.\]/);
	assert.ok(text.endsWith("[Only the first 2000 rows are shown; the sheet goes to row 2006.]"), "short rows fit the text cap");
	const grid = sheetGrid('<row><c><v>a</v></c><c r="BZ1"><v>far</v></c></row>', []);
	assert.equal(grid.moreColumns, true);
	assert.deepEqual(grid.rows, [["a"]]);
});

test("pptx: slides in presentation order, titles as headings, other text as items", async () => {
	const slide = (title: string, body: string) =>
		`<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` +
		`<p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
	const path = await file(
		"deck.pptx",
		makeZip({
			"ppt/presentation.xml": '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId8"/><p:sldId id="257" r:id="rId7"/></p:sldIdLst></p:presentation>',
			"ppt/_rels/presentation.xml.rels":
				'<Relationships><Relationship Id="rId7" Target="slides/slide1.xml"/><Relationship Id="rId8" Target="slides/slide2.xml"/></Relationships>',
			"ppt/slides/slide1.xml": slide("Second", "<a:p><a:r><a:t>Point A</a:t></a:r><a:br/><a:r><a:t>more</a:t></a:r></a:p>"),
			"ppt/slides/slide2.xml": slide("First", "<a:p><a:r><a:t>Hello</a:t></a:r></a:p><a:p></a:p>"),
		}),
	);
	const text = (await readOffice(path)) ?? "";
	assert.equal(
		text.replace(/^PowerPoint presentation .*deck\.pptx/, "P"),
		[
			"P: 2 slides. Shown as Markdown, 10 lines.",
			"",
			"## Slide 1",
			"",
			"### First",
			"- Hello",
			"",
			"## Slide 2",
			"",
			"### Second",
			"- Point A\n  more",
		].join("\n"),
	);
	assert.deepEqual(slideLines("<p:sp><p:txBody><a:p></a:p></p:txBody></p:sp>"), []);
});

test("office: offset and limit choose lines; the text cap cuts long documents; other ZIP files are not Office", async () => {
	const lines = Array.from({ length: 30 }, (_, index) => para(`Line ${index + 1}`));
	const path = await file("doc.docx", docx(lines.join("")));
	const window = (await readOffice(path, { offset: 5, limit: 3 })) ?? "";
	assert.match(window, /^Word document .*doc\.docx\. Shown as Markdown, 30 lines\.\n\nLine 5\nLine 6\nLine 7\n\n\[Lines 5-7 of 30 are shown\. Read on with offset: 8\.\]$/);
	assert.match((await readOffice(path, { offset: 31 })) ?? "", /\[offset 31 is past the end\.\]$/);
	assert.doesNotMatch((await readOffice(path, { offset: 25 })) ?? "", /Read on/);
	const long = await file("long.docx", docx(Array.from({ length: 100 }, () => para("x".repeat(999))).join("")));
	const cut = (await readOffice(long)) ?? "";
	assert.ok(cut.length < MAX_OFFICE_TEXT_CHARS + 500);
	assert.match(cut, /\[Lines 1-24 of 100 are shown\. Read on with offset: 25\.\]$/);
	assert.equal(await readOffice(await file("plain.zip", makeZip({ "readme.txt": "hi" }))), undefined);
	const empty = await file("empty.docx", docx(""));
	assert.match((await readOffice(empty)) ?? "", /Shown as Markdown, 0 lines\.\n\n\(no text\)$/);
});
