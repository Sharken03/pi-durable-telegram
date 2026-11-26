import { createReadStream } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { createInflateRaw } from "node:zlib";

/**
 * A small ZIP reader for Office files (docx, xlsx and pptx are ZIP archives of XML files). It reads only the central
 * directory and the entries it is asked for, and it caps what it unpacks, so a ZIP bomb costs at most the cap.
 */

/** Archives with more files than this are refused. */
export const MAX_ZIP_ENTRIES = 10_000;
const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const STORED = 0;
const DEFLATED = 8;

export class ZipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ZipError";
	}
}

export type ZipEntry = {
	readonly name: string;
	readonly flags: number;
	readonly method: number;
	readonly compressedSize: number;
	readonly size: number;
	readonly localOffset: number;
};

export type ZipArchive = { readonly path: string; readonly entries: ReadonlyMap<string, ZipEntry> };

/** Bytes that may still be unpacked in one read; each entry read takes from it. */
export type UnpackBudget = { left: number };

/** The directory of the ZIP file at `path`. Throws `ZipError` for a damaged, ZIP64 or too large archive. */
export async function openZip(path: string): Promise<ZipArchive> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const tailLength = Math.min(size, EOCD_BYTES + MAX_COMMENT_BYTES);
		const tail = await readAt(handle, size - tailLength, tailLength);
		const at = lastIndexOfSignature(tail);
		if (at < 0) throw new ZipError("no ZIP directory found (the file is damaged or cut off)");
		const count = tail.readUInt16LE(at + 10);
		const directorySize = tail.readUInt32LE(at + 12);
		const directoryOffset = tail.readUInt32LE(at + 16);
		if (count === 0xffff || directoryOffset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
		if (count > MAX_ZIP_ENTRIES) throw new ZipError(`it holds ${count} files; at most ${MAX_ZIP_ENTRIES} are read`);
		if (directorySize > MAX_DIRECTORY_BYTES || directoryOffset + directorySize > size) {
			throw new ZipError("the ZIP directory is damaged");
		}
		return { path, entries: parseDirectory(await readAt(handle, directoryOffset, directorySize), count) };
	} finally {
		await handle.close();
	}
}

function lastIndexOfSignature(tail: Buffer): number {
	for (let at = tail.length - EOCD_BYTES; at >= 0; at -= 1) {
		if (tail.readUInt32LE(at) === EOCD_SIGNATURE) return at;
	}
	return -1;
}

function parseDirectory(directory: Buffer, count: number): Map<string, ZipEntry> {
	const entries = new Map<string, ZipEntry>();
	let at = 0;
	for (let index = 0; index < count; index += 1) {
		if (at + 46 > directory.length || directory.readUInt32LE(at) !== DIRECTORY_SIGNATURE) {
			throw new ZipError("the ZIP directory is damaged");
		}
		const nameLength = directory.readUInt16LE(at + 28);
		const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
		entries.set(name, {
			name,
			flags: directory.readUInt16LE(at + 8),
			method: directory.readUInt16LE(at + 10),
			compressedSize: directory.readUInt32LE(at + 20),
			size: directory.readUInt32LE(at + 24),
			localOffset: directory.readUInt32LE(at + 42),
		});
		at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
	}
	return entries;
}

export type Unpacked = { readonly bytes: Buffer; readonly cut: boolean };

/**
 * Unpack one entry, at most `maxBytes` and at most what `budget` has left; `cut` tells that bytes were left out.
 * Undefined when the archive has no such entry. Throws `ZipError` for an encrypted or damaged entry.
 */
export async function readEntry(
	zip: ZipArchive,
	name: string,
	maxBytes: number,
	budget: UnpackBudget,
): Promise<Unpacked | undefined> {
	const entry = zip.entries.get(name);
	if (entry === undefined) return undefined;
	if ((entry.flags & 1) !== 0) throw new ZipError(`${name} is encrypted`);
	if (entry.method !== STORED && entry.method !== DEFLATED) {
		throw new ZipError(`${name} uses ZIP compression method ${entry.method}, which is not supported`);
	}
	const limit = Math.max(0, Math.min(maxBytes, budget.left));
	const start = await dataStart(zip.path, entry);
	const unpacked =
		entry.compressedSize === 0
			? { bytes: Buffer.alloc(0), cut: false }
			: entry.method === STORED
				? await readStored(zip.path, start, entry.compressedSize, limit)
				: await inflateLimited(zip.path, start, entry.compressedSize, limit);
	budget.left -= unpacked.bytes.length;
	return unpacked;
}

/** Where the entry's data starts: after its local header, whose name and extra field lengths can differ. */
async function dataStart(path: string, entry: ZipEntry): Promise<number> {
	const handle = await open(path, "r");
	try {
		const header = await readAt(handle, entry.localOffset, 30);
		if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
			throw new ZipError(`the ZIP entry ${entry.name} is damaged`);
		}
		return entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
	} finally {
		await handle.close();
	}
}

async function readStored(path: string, start: number, length: number, limit: number): Promise<Unpacked> {
	const handle = await open(path, "r");
	try {
		const bytes = await readAt(handle, start, Math.min(length, limit));
		return { bytes, cut: length > bytes.length };
	} finally {
		await handle.close();
	}
}

/** Stream-inflate from the file and stop at `limit` output bytes, so a small entry cannot unpack into gigabytes. */
function inflateLimited(path: string, start: number, length: number, limit: number): Promise<Unpacked> {
	return new Promise((resolve, reject) => {
		const source = createReadStream(path, { start, end: start + length - 1 });
		const inflate = createInflateRaw();
		const chunks: Buffer[] = [];
		let total = 0;
		const finish = (cut: boolean) => {
			source.destroy();
			inflate.destroy();
			resolve({ bytes: Buffer.concat(chunks, total), cut });
		};
		inflate.on("data", (chunk: Buffer) => {
			const room = limit - total;
			if (chunk.length > room) {
				chunks.push(chunk.subarray(0, room));
				total = limit;
				finish(true);
				return;
			}
			chunks.push(chunk);
			total += chunk.length;
		});
		inflate.on("end", () => finish(false));
		inflate.on("error", (error) => {
			source.destroy();
			reject(new ZipError(`the packed data is damaged (${error.message})`));
		});
		source.on("error", (error) => {
			inflate.destroy();
			reject(error);
		});
		source.pipe(inflate);
	});
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead);
}
