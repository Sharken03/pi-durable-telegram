import { createHash } from "node:crypto";
import { mkdtemp, readdir, rename, rm, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDir } from "../../runtime/private-dir.ts";

/**
 * Files the read tool derives from a source file: rendered PDF pages and HEIC images converted to JPEG. The request
 * hook reads an image again from its path for each model request, so a derived image must outlive the tool call. The
 * cache keeps the newest `maxFiles` files and at most `maxBytes`; the oldest go first. Work folders are removed
 * after each conversion.
 */
export type FileCache = { readonly dir: string; readonly maxFiles: number; readonly maxBytes: number };

export const CACHE_MAX_FILES = 64;
export const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const WORK_PREFIX = "work-";

export function fileCache(dir: string): FileCache {
	return { dir, maxFiles: CACHE_MAX_FILES, maxBytes: CACHE_MAX_BYTES };
}

/** What makes a source file the same file: its path, size and modification time. */
export type SourceId = { readonly path: string; readonly size: number; readonly mtimeMs: number };

/** The cache path of the derived file `variant` (such as `page-3.png`) of `source`. */
export function cachePath(cache: FileCache, source: SourceId, variant: string): string {
	const key = createHash("sha256")
		.update(`${source.path}\0${source.size}\0${source.mtimeMs}\0${variant}`)
		.digest("hex")
		.slice(0, 32);
	return join(cache.dir, `${key}-${variant}`);
}

/** True when `path` is already in the cache; it is touched, so pruning keeps it. */
export async function isCached(path: string): Promise<boolean> {
	try {
		const now = new Date();
		await utimes(path, now, now);
		return true;
	} catch {
		return false;
	}
}

/** Run `work` in a new private work folder inside the cache; the folder is always removed afterwards. */
export async function inWorkDir<T>(cache: FileCache, work: (dir: string) => Promise<T>): Promise<T> {
	await ensurePrivateDir(cache.dir);
	const dir = await mkdtemp(join(cache.dir, WORK_PREFIX));
	try {
		return await work(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Move a finished file into the cache at `target`, then prune the cache. */
export async function store(cache: FileCache, from: string, target: string): Promise<void> {
	await rename(from, target);
	await prune(cache, target);
}

type CachedFile = { readonly path: string; readonly size: number; readonly mtimeMs: number };

/** Delete the oldest files beyond the limits; `keep` is never deleted. Errors are ignored: the cache is a helper. */
async function prune(cache: FileCache, keep: string): Promise<void> {
	const names = await readdir(cache.dir).catch(() => [] as string[]);
	const files = await Promise.all(
		names
			.filter((name) => !name.startsWith(WORK_PREFIX))
			.map(async (name) => {
				const path = join(cache.dir, name);
				const info = await stat(path).catch(() => undefined);
				return info?.isFile() === true ? { path, size: info.size, mtimeMs: info.mtimeMs } : undefined;
			}),
	);
	const newest = files.filter((file): file is CachedFile => file !== undefined).sort((a, b) => b.mtimeMs - a.mtimeMs);
	let bytes = 0;
	for (const [index, file] of newest.entries()) {
		bytes += file.size;
		if (file.path === keep || (index < cache.maxFiles && bytes <= cache.maxBytes)) continue;
		await unlink(file.path).catch(() => undefined);
	}
}
