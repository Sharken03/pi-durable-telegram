/** File formats the read tool knows by content (magic bytes), never by file name. Never throws. */

/** PDF: `%PDF-` in the first 1024 bytes, where readers accept it. */
export function isPdf(header: Uint8Array): boolean {
	const head = Buffer.from(header.buffer, header.byteOffset, Math.min(header.length, 1024));
	return head.indexOf("%PDF-", 0, "latin1") !== -1;
}

const HEIF_BRANDS: ReadonlySet<string> = new Set(["heic", "heix", "heim", "heis", "mif1", "msf1", "avif", "avis"]);

/** The HEIF or AVIF brand of an ISO-BMFF `ftyp` box (major or compatible brand), or undefined. */
export function heifBrand(header: Uint8Array): string | undefined {
	if (header.length < 16 || latin1(header, 4, 8) !== "ftyp") return undefined;
	const major = latin1(header, 8, 12);
	if (HEIF_BRANDS.has(major)) return major;
	const boxSize = Math.min(u32be(header, 0), header.length);
	for (let at = 16; at + 4 <= boxSize; at += 4) {
		const brand = latin1(header, at, at + 4);
		if (HEIF_BRANDS.has(brand)) return brand;
	}
	return undefined;
}

/** A ZIP archive (docx, xlsx and pptx are ZIP files). */
export function isZip(header: Uint8Array): boolean {
	return startsWith(header, [0x50, 0x4b, 0x03, 0x04]);
}

/** An OLE2 compound file: legacy Office formats (doc, xls, ppt) and some others (msg). */
export function isOle(header: Uint8Array): boolean {
	return startsWith(header, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
	return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
	return String.fromCharCode(...bytes.subarray(start, end));
}

function u32be(bytes: Uint8Array, at: number): number {
	const low = ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
	return (bytes[at] ?? 0) * 0x1000000 + low;
}
