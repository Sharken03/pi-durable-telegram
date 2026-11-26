import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type ProgramPath, runProgram } from "../../media/programs.ts";
import { cachePath, type FileCache, inWorkDir, isCached, type SourceId, store } from "./file-cache.ts";

/** JPEG qualities to try, best first: a large photo is made again at a lower quality until it fits the model. */
const QUALITIES = [85, 60, 35] as const;
const HEADER_BYTES = 64 * 1024;
const LOG_OUTPUT_BYTES = 64 * 1024;

/** The format name of a HEIF brand, for texts: HEIC (HEVC), AVIF (AV1) or HEIF. */
export function heifKind(brand: string): string {
	if (brand.startsWith("hei")) return "HEIC";
	if (brand.startsWith("avi")) return "AVIF";
	return "HEIF";
}

export type HeifDeps = {
	readonly programs: ProgramPath;
	readonly cache: FileCache;
	/** Largest image file the model takes. */
	readonly maxImageBytes: number;
	readonly signal?: AbortSignal;
};

/** A JPEG made from a HEIF or AVIF file, in the file cache. */
export type ConvertedImage = {
	readonly path: string;
	readonly size: number;
	readonly header: Uint8Array;
	readonly quality: number;
};

/**
 * Convert a HEIF, HEIC or AVIF file to JPEG with heif-dec, or reuse the cached JPEG. The result can still be larger
 * than `maxImageBytes` when even the lowest quality is too large. Throws `ProgramError` when heif-dec is missing or
 * fails; returns an error text when it wrote no image.
 */
export async function convertHeif(source: SourceId, deps: HeifDeps): Promise<ConvertedImage | string> {
	let converted: ConvertedImage | undefined;
	for (const quality of QUALITIES) {
		const target = cachePath(deps.cache, source, `heif-q${quality}.jpg`);
		if (!(await isCached(target)) && !(await decodeInto(source.path, quality, target, deps))) {
			return "heif-dec wrote no image";
		}
		converted = { path: target, size: (await stat(target)).size, header: await readHeader(target), quality };
		if (converted.size <= deps.maxImageBytes) return converted;
	}
	return converted ?? "heif-dec wrote no image";
}

/** Decode into a work folder; heif-dec numbers the files (out-1.jpg, ...) when the file holds more than one image. */
async function decodeInto(file: string, quality: number, target: string, deps: HeifDeps): Promise<boolean> {
	return inWorkDir(deps.cache, async (dir) => {
		await runProgram(deps.programs, "heif-dec", ["-q", String(quality), file, join(dir, "out.jpg")], {
			maxOutputBytes: LOG_OUTPUT_BYTES,
			...(deps.signal === undefined ? {} : { signal: deps.signal }),
		});
		const names = (await readdir(dir)).filter((name) => /^out.*\.jpe?g$/.test(name)).sort(byNumber);
		const pick = names.includes("out.jpg") ? "out.jpg" : names[0];
		if (pick === undefined) return false;
		await store(deps.cache, join(dir, pick), target);
		return true;
	});
}

function byNumber(a: string, b: string): number {
	return a.localeCompare(b, "en", { numeric: true });
}

async function readHeader(path: string): Promise<Uint8Array> {
	const handle = await open(path, "r");
	try {
		const header = Buffer.alloc(HEADER_BYTES);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		return header.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}
