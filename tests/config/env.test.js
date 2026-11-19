import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv, updateEnvText, updateEnvFile, loadEnv } from "../../src/config/env.js";
import { tempDir } from "../helpers/fakes.js";

test("parseEnv reads plain, quoted, exported and commented lines", () => {
  const values = parseEnv(
    [
      "# a comment",
      "PLAIN=value",
      'DOUBLE="has spaces and a \\"quote\\""',
      "SINGLE='kept $as is'",
      "export EXPORTED=yes",
      "INLINE=value # trailing comment",
      "EMPTY=",
      "not a variable line",
    ].join("\n"),
  );
  assert.deepEqual(values, {
    PLAIN: "value",
    DOUBLE: 'has spaces and a "quote"',
    SINGLE: "kept $as is",
    EXPORTED: "yes",
    INLINE: "value",
    EMPTY: "",
  });
});

test("updateEnvText replaces keys in place and keeps other lines", () => {
  const before = "# mine\nKEEP=1\nGITHUB_APP_ID=1\n";
  const after = updateEnvText(before, { GITHUB_APP_ID: "42", NEW_KEY: "two words" }, { section: "Added" });
  assert.equal(after, '# mine\nKEEP=1\nGITHUB_APP_ID=42\n\n# Added\nNEW_KEY="two words"\n');
  assert.equal(parseEnv(after).NEW_KEY, "two words");
});

test("keys saved one at a time share their section's heading", () => {
  let text = updateEnvText("A=1\n", { SLACK_BOT_TOKEN: "x" }, { section: "Slack" });
  text = updateEnvText(text, { OTHER: "y" }, { section: "Other" });
  text = updateEnvText(text, { SLACK_APP_TOKEN: "z" }, { section: "Slack" });
  assert.equal(text, "A=1\n\n# Slack\nSLACK_BOT_TOKEN=x\nSLACK_APP_TOKEN=z\n\n# Other\nOTHER=y\n");
});

test("updateEnvText removes a key set to null", () => {
  assert.equal(updateEnvText("A=1\nB=2\n", { A: null }), "B=2\n");
});

test("values round-trip through write and parse", () => {
  const tricky = 'line one\nline "two" with #hash and \\backslash';
  const text = updateEnvText("", { TRICKY: tricky });
  assert.equal(parseEnv(text).TRICKY, tricky);
});

test("updateEnvFile writes a file only its owner can read", (t) => {
  const path = join(tempDir(t), ".env");
  updateEnvFile(path, { SECRET: "x" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(readFileSync(path, "utf8"), /^SECRET=x$/m);
});

test("loadEnv never overrides a variable already set", (t) => {
  const path = join(tempDir(t), ".env");
  writeFileSync(path, "A=from-file\nB=from-file\n");
  const env = { A: "from-shell" };
  loadEnv(path, env);
  assert.deepEqual(env, { A: "from-shell", B: "from-file" });
});
