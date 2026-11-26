import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { attachImages } from "../../src/agent/tools/image-read.ts";
import { realInside } from "../../src/agent/tools/path-guard.ts";
import { tempDir } from "../helpers/agent.ts";
import { pngBytes } from "../helpers/images.ts";

test("realInside: the root and paths under it; .., symlinks out, dangling links and look-alike names are not", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const work = join(dir, "work");
		await mkdir(join(work, "sub"), { recursive: true });
		await writeFile(join(dir, "outside.txt"), "x");
		await symlink(join(dir, "outside.txt"), join(work, "out.txt"));
		await symlink(join(work, "sub"), join(work, "in"));
		await symlink(join(dir, "gone.txt"), join(work, "dangling.txt"));
		await mkdir(join(dir, "work-other"));
		const roots = [work];
		assert.ok((await realInside(work, roots)) !== undefined, "the root itself");
		assert.ok((await realInside(join(work, "new", "deep", "file.txt"), roots)) !== undefined, "a new file");
		assert.ok((await realInside(join(work, "in", "x.txt"), roots)) !== undefined, "a link that stays inside");
		assert.ok((await realInside(join(work, "..file"), roots)) !== undefined, "a name that starts with ..");
		assert.equal(await realInside(join(work, "..", "outside.txt"), roots), undefined);
		assert.equal(await realInside(join(work, "out.txt"), roots), undefined, "a link that points out");
		assert.equal(await realInside(join(work, "dangling.txt"), roots), undefined, "a link to nothing");
		assert.equal(await realInside(join(dir, "work-other", "a"), roots), undefined, "not a prefix match");
		assert.ok((await realInside(join(dir, "outside.txt"), [work, dir])) !== undefined, "any of the roots");
	} finally {
		await cleanup();
	}
});

test("attachImages: an image outside the allowed folders is not attached", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const path = join(dir, "pic.png");
		await writeFile(path, pngBytes(8, 8));
		const message = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "Image attached." }],
			details: { imagePath: path, mime: "image/png" },
			isError: false,
			timestamp: 0,
		} as Message;
		const options = { maxBytes: 1_000_000, canView: true };
		const refused = await attachImages([message], { ...options, allowed: async () => false });
		const parts = (refused[0] as Extract<Message, { role: "toolResult" }>).content;
		assert.deepEqual(parts.at(-1), { type: "text", text: "[image not available: outside the working directory]" });
		const allowed = await attachImages([message], { ...options, allowed: async () => true });
		assert.equal((allowed[0] as Extract<Message, { role: "toolResult" }>).content.at(-1)?.type, "image");
	} finally {
		await cleanup();
	}
});
