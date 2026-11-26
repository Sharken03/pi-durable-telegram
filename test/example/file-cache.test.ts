import assert from "node:assert/strict";
import { readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { cachePath, inWorkDir, isCached, store } from "../../src/agent/tools/file-cache.ts";
import { tempDir } from "../helpers/agent.ts";

test("file cache: keys follow the source, the oldest files go first, work folders are removed", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const cache = { dir: join(dir, "cache"), maxFiles: 2, maxBytes: 1000 };
		const source = { path: "/w/a.pdf", size: 10, mtimeMs: 1 };
		assert.notEqual(cachePath(cache, source, "page-1.png"), cachePath(cache, { ...source, mtimeMs: 2 }, "page-1.png"));
		assert.match(cachePath(cache, source, "page-1.png"), /\/cache\/[0-9a-f]{32}-page-1\.png$/);
		const targets: string[] = [];
		for (const page of [1, 2, 3]) {
			const target = cachePath(cache, source, `page-${page}.png`);
			targets.push(target);
			await inWorkDir(cache, async (work) => {
				await writeFile(join(work, "out.png"), "x");
				await utimes(join(work, "out.png"), page, page);
				await store(cache, join(work, "out.png"), target);
			});
		}
		const names = await readdir(cache.dir);
		assert.equal(names.length, 2, "two files kept, no work folder left");
		assert.equal(await isCached(targets[0] ?? ""), false, "the oldest file is gone");
		assert.equal(await isCached(targets[2] ?? ""), true);
		// isCached touched the file; make it old again, so the next file is the newest.
		await utimes(targets[2] ?? "", 5, 5);
		await inWorkDir(cache, async (work) => {
			await writeFile(join(work, "big.png"), Buffer.alloc(2000));
			await store(cache, join(work, "big.png"), join(cache.dir, "big.png"));
		});
		assert.deepEqual(await readdir(cache.dir), ["big.png"], "a new file stays even when it alone is over the size limit");
	} finally {
		await cleanup();
	}
});
