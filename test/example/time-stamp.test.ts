import assert from "node:assert/strict";
import { test } from "node:test";
import { startOf } from "../../src/channel/commands/new.ts";
import { timeStamp, withoutTimeStamp, withTimeStamp } from "../../src/channel/time-stamp.ts";

test("time stamp: local date, 24-hour time and the zone name, in winter and in summer", () => {
	const winter = new Date(Date.UTC(2026, 10, 26, 16, 50, 59));
	const summer = new Date(Date.UTC(2026, 6, 1, 6, 5));
	assert.equal(timeStamp(winter, "Europe/Copenhagen"), "[2026-11-26 17:50 CET]");
	assert.equal(timeStamp(summer, "Europe/Copenhagen"), "[2026-07-01 08:05 CEST]");
	assert.equal(timeStamp(winter, "UTC"), "[2026-11-26 16:50 UTC]");
	assert.equal(timeStamp(new Date(Date.UTC(2026, 11, 31, 23, 30)), "Europe/Copenhagen"), "[2027-01-01 00:30 CET]");
});

test("time stamp: a line before the text, removed again only at the start", () => {
	const date = new Date(Date.UTC(2026, 10, 26, 16, 50));
	const stamped = withTimeStamp("What time is it?", date, { timeZone: "Europe/Copenhagen" });
	assert.equal(stamped, "[2026-11-26 17:50 CET]\nWhat time is it?");
	const noted = withTimeStamp("Hi", date, { timeZone: "Europe/Copenhagen", note: "effort high · preset fast" });
	assert.equal(noted, "[2026-11-26 17:50 CET · effort high · preset fast]\nHi", "the effort and preset after a dot");
	assert.equal(withoutTimeStamp(noted), "Hi");
	assert.equal(withoutTimeStamp(stamped), "What time is it?");
	assert.equal(withoutTimeStamp("a\n[2026-11-26 17:50 CET]\nb"), "a\n[2026-11-26 17:50 CET]\nb");
	assert.equal(startOf(stamped), "What time is it?");
});
