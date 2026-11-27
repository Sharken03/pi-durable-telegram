/** A small MCP client over Streamable HTTP: initialize once, then `tools/call`. It is what the workers plugin uses to
 * reach the phone's home-agent, so the bot never needs a shell of its own. */

type Answer = { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };

export type WorkerClient = {
	/** The tool's result as text: a framed log for `agent_result`, JSON for the rest. */
	call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
	/** The same, parsed: the tools of home-agent answer with JSON. */
	json<T = Record<string, unknown>>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
};

const TIMEOUT_MS = 60_000;

export function createWorkerClient(url: string, token: string): WorkerClient {
	let session: string | undefined;
	let nextId = 0;

	async function post(body: unknown, signal?: AbortSignal): Promise<Answer> {
		const sent = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${token}`,
				...(session === undefined ? {} : { "mcp-session-id": session }),
			},
			body: JSON.stringify(body),
			signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
		});
		const found = sent.headers.get("mcp-session-id");
		if (found !== null) session = found;
		if (!sent.ok) {
			// A session the server forgot is not an error: the next call makes a new one.
			if (sent.status === 404 || sent.status === 400) session = undefined;
			throw new Error(`home-agent answered ${sent.status}: ${(await sent.text()).slice(0, 200)}`);
		}
		// Streamable HTTP answers either a JSON body or one SSE event with the JSON in `data:`.
		const text = await sent.text();
		const payload = text.startsWith("event:") || text.startsWith("data:") ? dataOf(text) : text;
		if (payload.trim() === "") return {};
		try {
			return JSON.parse(payload) as Answer;
		} catch {
			throw new Error(`home-agent sent something that is not JSON: ${payload.slice(0, 200)}`);
		}
	}

	async function initialize(signal?: AbortSignal): Promise<void> {
		session = undefined;
		await post(
			{
				jsonrpc: "2.0",
				id: ++nextId,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "pi-durable-telegram", version: "1" },
				},
			},
			signal,
		);
	}

	async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
		for (let attempt = 0; ; attempt++) {
			if (session === undefined) await initialize(signal);
			const answer = await post(
				{ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name, arguments: args } },
				signal,
			);
			if (answer.error !== undefined) throw new Error(`home-agent: ${answer.error.message ?? "the call failed"}`);
			const content = answer.result?.content?.[0]?.text ?? "";
			if (answer.result?.isError === true) throw new Error(content === "" ? `${name} failed` : content);
			return content;
		}
	}

	return {
		call,
		async json<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
			const text = await call(name, args, signal);
			try {
				return JSON.parse(text) as T;
			} catch {
				throw new Error(`${name} did not answer with JSON: ${text.slice(0, 200)}`);
			}
		},
	};
}

/** The JSON of the first `data:` line in an SSE body. */
function dataOf(text: string): string {
	for (const line of text.split("\n")) {
		if (line.startsWith("data: ")) return line.slice(6);
	}
	return "";
}
