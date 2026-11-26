import type { CompactionPolicy, HarnessSettings } from "@earendil-works/pi-durable";

/** How often streamed partials are committed; Telegram shows about one edit per second anyway. */
export const PARTIAL_INTERVAL_MS = 300;

/** pi-durable's defaults for the thresholds a cap changes (harness `DEFAULT_COMPACTION_POLICY`). */
const DEFAULT_RESERVE_TOKENS = 16384;
const DEFAULT_BACKGROUND_TOKENS = 32768;
const DEFAULT_KEEP_RECENT_TOKENS = 20000;

/**
 * Harness settings. `contextCap` limits the context the model works with: blocking compaction starts at the cap (by
 * keeping `contextWindow - contextCap` tokens in reserve), background compaction at most a quarter below it, and a
 * compaction keeps at most a third of the cap, so a compacted context stays under both thresholds. `contextWindow` is
 * the default model's; `windowOf` gives the window of any other model (`provider/modelId`) a chat switches to, so
 * its thresholds follow its own window.
 */
export function createSettings(
	options: { contextCap?: number; contextWindow?: number; windowOf?: (ref: string) => number | undefined } = {},
): HarnessSettings {
	const { contextCap, contextWindow, windowOf } = options;
	const capped = contextCap !== undefined && contextWindow !== undefined && contextCap < contextWindow;
	const policy = capped ? cappedCompaction(contextCap, contextWindow) : {};
	const perModel = contextCap !== undefined && windowOf !== undefined;
	const compaction = perModel ? { ...policy, modelOverrides: overrides(contextCap, windowOf) } : policy;
	return {
		progress: { partialIntervalMs: PARTIAL_INTERVAL_MS, outputIntervalMs: 500 },
		// Per-minute provider limits need a longer window: 5/10/20/40/60 seconds.
		retry: { enabled: true, maxRetries: 5, baseDelayMs: 5000, maxAgentDelayMs: 60000 },
		...(capped || perModel ? { compaction } : {}),
	};
}

/**
 * pi-durable reads `modelOverrides["provider/modelId"]` at each resolution, so a lookup answers for any model: the
 * capped policy for its window, or pi-durable's defaults when the cap is not below it.
 */
function overrides(cap: number, windowOf: (ref: string) => number | undefined): Overrides {
	return new Proxy({} as Overrides, {
		get: (_target, key) => {
			const window = typeof key === "string" ? windowOf(key) : undefined;
			if (window === undefined) return undefined;
			return cap < window ? cappedCompaction(cap, window) : DEFAULT_POLICY;
		},
	});
}

type Overrides = Record<string, Partial<CompactionPolicy>>;

const DEFAULT_POLICY: Partial<CompactionPolicy> = {
	reserveTokens: DEFAULT_RESERVE_TOKENS,
	keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
	backgroundTokens: DEFAULT_BACKGROUND_TOKENS,
};

function cappedCompaction(cap: number, window: number) {
	return {
		reserveTokens: window - cap,
		keepRecentTokens: Math.min(DEFAULT_KEEP_RECENT_TOKENS, Math.floor(cap / 3)),
		backgroundTokens: Math.min(DEFAULT_BACKGROUND_TOKENS, Math.floor(cap / 4)),
	};
}
