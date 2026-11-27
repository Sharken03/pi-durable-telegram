import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import type { CompactReportTask } from "../delivery/compact-report.ts";
import type { DeliverTask } from "../delivery/task.ts";
import { createReminderTask } from "../plugins/reminders/task.ts";
import { createWorkerTask } from "../plugins/workers/task.ts";
import type { Logger } from "../runtime/log.ts";
import type { TelegramPort } from "../telegram/port.ts";
import { createRenameTopicTool } from "../telegram/rename-topic.ts";
import { createSendFileTool } from "../telegram/send-file.ts";
import { ChatSettings } from "./docs.ts";
import { createTopicNameSection, type TopicNamesMode } from "./topic-names.ts";

/**
 * The durable part of the channel: its task definitions and Telegram file/topic tools. The reminder and worker tasks
 * are here, not in their plugins, so tasks left behind by a plugin that is now off never block startup.
 */
export function createTelegramExtension(options: {
	deliver: DeliverTask;
	compactReport: CompactReportTask;
	port: () => TelegramPort;
	log: Logger;
	/** The agent's working directory: `telegram_send_file` sends only files in it. */
	workdir: string;
	allowed: ReadonlySet<number>;
	topicNames?: TopicNamesMode;
	uploadLimit?: number;
	/** The projects directory on the phone; a chat's project is a path inside it. */
	phoneProjects: string;
}): Extension {
	const sendFile = createSendFileTool({
		port: options.port,
		log: options.log,
		workdir: options.workdir,
		...(options.uploadLimit === undefined ? {} : { uploadLimit: options.uploadLimit }),
	});
	const topicNames = options.topicNames ?? "auto";
	const renameTopic = createRenameTopicTool({ port: options.port, log: options.log, topicNames });
	return defineExtension({
		name: "telegram",
		tasks: [
			options.deliver,
			options.compactReport,
			createReminderTask(options.allowed),
			createWorkerTask(),
		],
		tools: [sendFile, renameTopic],
		sections: [createTopicNameSection(topicNames), projectSection(options.phoneProjects)],
	});
}

/**
 * Where this chat works: on the phone. The bot has no copy of the project and its own read/write/edit tools work in
 * the bot's directory, so the section names the phone tools — and says nothing while the chat uses the root.
 */
export function projectSection(phoneProjects: string) {
	return section("project", async (input, context) => {
		const project = (await input.read.snapshot(ChatSettings, input.conversationId, context))?.project;
		const root = project ?? phoneProjects;
		return [
			`This chat's project is the directory ${root} on the phone (the 8T), not on this machine.`,
			"Read and change it with the phone's tools, all prefixed mcp__agent8t__: list_project_files,",
			"read_project_file, read_project_lines, search_project_files, edit_project_file and make_project_dir,",
			"with full paths inside that directory. The local read, write and edit tools work in the bot's own",
			"directory, not in the project. An agent started with start_worker in that directory does the heavier work there.",
		].join("\n");
	});
}
