import type { Context } from "@earendil-works/chord";
import {
	defineDoc,
	defineTask,
	type NextTaskState,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { ChatInfo } from "../../channel/docs.ts";
import { admitIn } from "../../channel/intake.ts";
import { DELIVER_TASK, type DeliverTask } from "../../delivery/task.ts";
import type { WorkerClient } from "./rpc.ts";

/** A worker the bot started and is waiting for: what `worker_status` lists and the wake removes. */
export type Watched = { worker: string; task: string; cwd: string; model: string; started: number };

/** The workers this chat watches, by task id. A watcher is a durable task, so a restart keeps waiting. */
export const WorkerWatch = defineDoc<{ items: Record<string, Watched> }>({
	kind: "tg.workers",
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: {} }),
});

export const WORKER_TASK = "tg.worker";
type Input = { id: string; worker: string };
type State = { phase: "poll"; due: number };
type Next = NextTaskState<State, null>;
type Runtime = TaskRuntime<Input, State, null, object>;
const TERMINAL: Next = { status: "terminal", outcome: { status: "completed", result: null } };

/** The client the plugin loaded; undefined when the plugin is off, and then a watcher only reports and stops. */
let client: WorkerClient | undefined;
export function setWorkerClient(next: WorkerClient | undefined): void {
	client = next;
}

/** How often a watcher asks the phone. Core registers the task, the plugin sets the pace. */
export const DEFAULT_POLL_MS = 15_000;
let pollMs = DEFAULT_POLL_MS;
export function setWorkerPollMs(ms: number): void {
	pollMs = ms;
}

type Status = { status?: string; seconds?: number; exit?: number };

/** The status of a worker as home-agent reports it. */
async function statusOf(worker: string): Promise<Status> {
	if (client === undefined) throw new Error("the workers plugin is off");
	return client.json<Status>("agent_status", { worker_id: worker });
}

/**
 * Wait for the worker, waking every `pollMs` on the harness clock: a sleeping task survives a restart, and the poll is a
 * durable sleep rather than a timer, so a service that was down resumes where it was. When the worker is done its log
 * becomes the chat's next message — in the topic that started it, since ChatInfo carries the thread.
 */
async function finish(tx: Tx, runtime: Runtime, worker: string): Promise<Next> {
	const doc = await tx.doc(WorkerWatch, runtime.conversationId);
	const entry = Object.hasOwn(doc.items, worker) ? doc.items[worker] : undefined;
	const status = await statusOf(worker).catch(() => undefined);
	const log = client === undefined ? "" : await client.call("agent_result", { worker_id: worker, lines: 40 }).catch(
		(error: unknown) => `(the log could not be read: ${error instanceof Error ? error.message : String(error)})`,
	);
	const state = status?.status ?? "unknown";
	const seconds = status?.seconds === undefined ? "" : `, ${Math.round(status.seconds)}s`;
	const head = entry === undefined ? `[worker ${worker} ${state}${seconds}]` : `[worker ${worker} ${state}${seconds}, ${entry.cwd}]`;
	const { chatId, threadId } = await tx.doc(ChatInfo, runtime.conversationId);
	const deliver = runtime.registry.task(DELIVER_TASK) as unknown as DeliverTask;
	await admitIn(tx, runtime.conversationId, deliver, {
		chatId,
		...(threadId === undefined ? {} : { threadId }),
		requestId: `worker:${worker}`,
		content: `${head}\n${log}`,
	});
	delete doc.items[worker];
	return TERMINAL;
}

/**
 * One background, conversation-owned task per worker. Core registers it whether or not the workers plugin is on, so a
 * watcher left by a restart never blocks startup: without the plugin it reports that and stops.
 */
export function createWorkerTask() {
	return defineTask<Input, State, null>({
		name: WORKER_TASK,
		version: 1,
		initial: () => ({ phase: "poll", due: 0 }),
		phases: {
			poll: async (task, runtime, context: Context) => {
				if (client === undefined) {
					runtime.report(new Error(`worker ${task.input.worker} is no longer watched: the workers plugin is off`));
					await runtime.commit(async (tx) => {
						delete (await tx.doc(WorkerWatch, runtime.conversationId)).items[task.input.worker];
					}, context);
					return TERMINAL;
				}
				const status = await statusOf(task.input.worker).catch(() => undefined);
				if (status?.status === "running" || status?.status === "starting") {
					await runtime.sleepUntil(runtime.now() + pollMs, task.state.checkpoint, context);
					return;
				}
				return runtime.commit((tx) => finish(tx, runtime, task.input.worker), context);
			},
		},
		abort: (task, runtime, context) =>
			runtime.commit(async (tx) => {
				delete (await tx.doc(WorkerWatch, runtime.conversationId)).items[task.input.worker];
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context),
	});
}

export type WorkerTask = ReturnType<typeof createWorkerTask>;
