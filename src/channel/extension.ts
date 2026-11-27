import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { CompactReportTask } from "../delivery/compact-report.ts";
import type { DeliverTask } from "../delivery/task.ts";
import { createReminderTask } from "../plugins/reminders/task.ts";
import { createWorkerTask } from "../plugins/workers/task.ts";
import type { Logger } from "../runtime/log.ts";
import type { TelegramPort } from "../telegram/port.ts";
import { createRenameTopicTool } from "../telegram/rename-topic.ts";
import { createSendFileTool } from "../telegram/send-file.ts";
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
		sections: [createTopicNameSection(topicNames)],
	});
}
