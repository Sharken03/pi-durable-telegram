import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { isAnimatedGif } from "../../src/agent/tools/image-probe.ts";
import { TelegramApiError } from "../../src/telegram/errors.ts";
import { CHAT, newFaux, startTestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastToolResult, observe, textOf, toolCall } from "../helpers/faux-steps.ts";
import { animatedGifBytes, gifBytes, pngBytes } from "../helpers/images.ts";
import { textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Seen = { isError: boolean; text: string; images: string[] };

function inspect(messages: readonly Message[]): Seen {
	const result = lastToolResult(messages);
	const images = (result?.content ?? []).flatMap((part) => (part.type === "image" ? [part.mimeType] : []));
	return { isError: result?.isError === true, text: textOf(result), images };
}

test("gif: frames and the loop block mark a GIF as animated; other bytes never do", () => {
	assert.equal(isAnimatedGif(animatedGifBytes(2)), true);
	assert.equal(isAnimatedGif(animatedGifBytes(1, true)), true);
	assert.equal(isAnimatedGif(animatedGifBytes(1)), false);
	assert.equal(isAnimatedGif(gifBytes(10, 20)), false);
	assert.equal(isAnimatedGif(pngBytes(4, 4)), false);
	assert.equal(isAnimatedGif(animatedGifBytes(3).subarray(0, 40)), false, "a cut first frame counts as one");
	for (let cut = 0; cut <= 60; cut += 1) isAnimatedGif(animatedGifBytes(3).subarray(0, cut));
});

test("gif: telegram_send_file sends an animated GIF as an animation, a still GIF and a refused one as documents", async () => {
	const faux = newFaux();
	const seen: Seen[] = [];
	const step = (next: ReturnType<typeof toolCall>) => observe((messages) => seen.push(inspect(messages)), next);
	faux.setResponses([
		toolCall("telegram_send_file", { path: "dance.gif", caption: "the dance" }),
		step(toolCall("telegram_send_file", { path: "still.gif" })),
		step(toolCall("telegram_send_file", { path: "odd.gif" })),
		step(fauxAssistantMessage("sent")),
	]);
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir, faux, port });
	cleanups.push(() => t.close());
	const work = join(dir, "work");
	await writeFile(join(work, "dance.gif"), animatedGifBytes(3, true));
	await writeFile(join(work, "still.gif"), animatedGifBytes(1));
	await writeFile(join(work, "odd.gif"), animatedGifBytes(2));
	let refused = 0;
	port.use((call) => {
		if (call.method === "sendAnimation" && call.text?.endsWith("odd.gif") === true) {
			refused += 1;
			throw new TelegramApiError("sendAnimation", 400, "Bad Request: wrong file");
		}
	});
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "send"));
	await waitFor(() => port.textsIn(CHAT).includes("sent"));
	assert.deepEqual(
		seen.map((s) => s.isError),
		[false, false, false],
	);
	assert.match(seen[0]?.text ?? "", /Sent dance\.gif .* as animation/);
	assert.match(seen[1]?.text ?? "", /Sent still\.gif .* as document/);
	assert.match(seen[2]?.text ?? "", /Sent odd\.gif .* as document/);
	assert.equal(refused, 1);
	const sent = port.created(CHAT).filter((m) => m.kind !== "text");
	assert.deepEqual(
		sent.map((m) => [m.kind, m.path?.split("/").pop()]),
		[
			["animation", "dance.gif"],
			["document", "still.gif"],
			["document", "odd.gif"],
		],
	);
	assert.equal(sent[0]?.caption, "the dance");
});

test("gif: read attaches an animated GIF as it is and says only its first frame may show", async () => {
	const faux = newFaux();
	const seen: Seen[] = [];
	const step = (next: ReturnType<typeof toolCall>) => observe((messages) => seen.push(inspect(messages)), next);
	faux.setResponses([
		toolCall("read", { path: "dance.gif" }),
		step(toolCall("read", { path: "still.gif" })),
		step(fauxAssistantMessage("seen")),
	]);
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir, faux, port });
	cleanups.push(() => t.close());
	const work = join(dir, "work");
	await writeFile(join(work, "dance.gif"), animatedGifBytes(3, true));
	await writeFile(join(work, "still.gif"), animatedGifBytes(1));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "look"));
	await waitFor(() => port.textsIn(CHAT).includes("seen"));
	assert.equal(seen[0]?.isError, false);
	assert.deepEqual(seen[0]?.images, ["image/gif"]);
	assert.match(seen[0]?.text ?? "", /dance\.gif \(2x2, .*\) is attached for viewing\. It is an animated GIF; only its first/);
	assert.equal(seen[1]?.isError, false);
	assert.doesNotMatch(seen[1]?.text ?? "", /animated/);
});
