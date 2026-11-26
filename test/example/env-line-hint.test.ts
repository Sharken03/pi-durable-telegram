import assert from "node:assert/strict";
import { test } from "node:test";
import { envLineHint } from "../../src/plugins/load.ts";

test("envLineHint: a PI_PLUGINS entry that is another variable gets a hint; plugin names get none", () => {
	assert.match(envLineHint("PI_MODEL_CHOICES=deepseek/deepseek-flash"), /remove the spaces after "PI_PLUGINS="/);
	assert.equal(envLineHint("skills"), "");
	assert.equal(envLineHint("./plugins/my-plugin.ts"), "");
	assert.equal(envLineHint("deepseek/deepseek-v4-pro"), "");
});
