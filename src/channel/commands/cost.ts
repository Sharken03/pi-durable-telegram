import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { phoneClient } from "../../plugins/workers/task.ts";
import { recordKey } from "../intake.ts";
import { type MessageScope, reply } from "../scope.ts";

/** One account as the phone answers: the line the phone's script printed, and how old it is. */
type Balance = { account: string; balance?: string | null; age_seconds?: number; error?: string };

/** What /cost shows, in the order the phone lists them: money, plan usage, weekly quota. */
const ORDER = ["deepseek", "openrouter", "openrouter_free", "claude", "agy"];
const MISSING: Readonly<Record<string, string>> = {
	deepseek: "DS: ?",
	openrouter: "OR: ?",
	openrouter_free: "OR: ?",
	claude: "Claude: ?",
	agy: "agy: ?",
};

/**
 * `/cost` asks the phone what is left at the providers: the DeepSeek and OpenRouter balances,
 * OpenRouter's free requests, the Claude plan usage and the agy weekly quota. The bot holds no
 * keys — the phone reads its own and prints one line each.
 */
export async function runCost(scope: MessageScope): Promise<void> {
	if (!(await recordKey(scope.conversation, scope.key, BG, scope.updateId))) return;
	const client = phoneClient();
	if (client === undefined) {
		await reply(scope, "No phone connection: the workers plugin is off (PI_PLUGINS), so there is no quota to read.");
		return;
	}
	let entries: Balance[];
	try {
		entries = await client.json<Balance[]>("get_balances", {});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		await reply(scope, `Could not read the quota from the phone: ${reason}`);
		return;
	}
	await reply(scope, format(entries));
}

/** The three lines: what is left to spend, what the plans allow, and when a used-up group is back. */
export function format(entries: readonly Balance[]): string {
	const byAccount = new Map(entries.map((entry) => [entry.account, entry.balance ?? MISSING[entry.account] ?? entry.account]));
	const line = (accounts: readonly string[]) => accounts.map((account) => byAccount.get(account) ?? MISSING[account]).join(" · ");
	return [line(["deepseek", "openrouter", "openrouter_free"]), line(["claude"]), line(["agy"])].join("\n");
}
