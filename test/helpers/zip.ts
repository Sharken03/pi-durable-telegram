import { crc32, deflateRawSync } from "node:zlib";

export type ZipOptions = { readonly stored?: boolean; readonly method?: number; readonly encrypted?: boolean };

/** A ZIP archive of `files` (name to content), deflated unless `stored`; enough for docx, xlsx and pptx tests. */
export function makeZip(files: Record<string, string | Uint8Array>, options: ZipOptions = {}): Buffer {
	const parts: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	const names = Object.keys(files);
	for (const name of names) {
		const content = files[name] ?? "";
		const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
		const packed = options.stored === true ? data : deflateRawSync(data);
		const method = options.method ?? (options.stored === true ? 0 : 8);
		const flags = 0x0800 | (options.encrypted === true ? 1 : 0);
		const nameBytes = Buffer.from(name, "utf8");
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc32(data), 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		parts.push(local, nameBytes, packed);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(flags, 8);
		entry.writeUInt16LE(method, 10);
		entry.writeUInt32LE(crc32(data), 16);
		entry.writeUInt32LE(packed.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(nameBytes.length, 28);
		entry.writeUInt32LE(offset, 42);
		directory.push(entry, nameBytes);
		offset += 30 + nameBytes.length + packed.length;
	}
	const central = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(names.length, 8);
	end.writeUInt16LE(names.length, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, central, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A docx with `body` (WordprocessingML inside `<w:body>`). */
export function docx(body: string): Buffer {
	return makeZip({
		"[Content_Types].xml": "<Types/>",
		"word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}</w:body></w:document>`,
	});
}

/** A paragraph with one run of `text`, optionally with a style. */
export function para(text: string, style?: string): string {
	const props = style === undefined ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
	return `<w:p>${props}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}
