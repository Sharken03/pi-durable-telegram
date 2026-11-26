/** A leading time stamp line as `withTimeStamp` writes it, for code that shows the start of a user message. */
const STAMP_LINE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: [^\]\n]+)?\]\n/;

/**
 * The local date, time and zone of `date`, such as `[2026-11-26 17:50 CET]`, and a `note` after a dot when given. The
 * model has no clock: the stamp on each user message tells it the time. It goes into the message, not the system
 * prompt, so the prompt cache stays valid; the note (effort level and preset) is there for the same reason.
 * `timeZone` is for tests; the default is the zone of the process.
 */
export function timeStamp(date: Date, timeZone?: string, note?: string): string {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "short",
	}).formatToParts(date);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
	const zone = part("timeZoneName");
	const clock = `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
	const noted = note === undefined || note === "" ? "" : ` · ${note}`;
	return `[${clock}${zone === "" ? "" : ` ${zone}`}${noted}]`;
}

/** The user's text with a time stamp line first, such as `[2026-11-26 17:50 CET · effort high · preset fast]`. */
export function withTimeStamp(text: string, date: Date, options: { note?: string; timeZone?: string } = {}): string {
	return `${timeStamp(date, options.timeZone, options.note)}\n${text}`;
}

/** The text without a leading time stamp line. */
export function withoutTimeStamp(text: string): string {
	return text.replace(STAMP_LINE, "");
}
