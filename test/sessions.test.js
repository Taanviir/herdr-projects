"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "projects-sessions-"));
process.env.PROJECTS_CLAUDE_DIR = path.join(root, "claude");
process.env.PROJECTS_CODEX_DIR = path.join(root, "codex");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const { index, fromCache, EDGE_BYTES } = require("../lib/sessions");

const jsonl = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
};
const claudeUser = (content, extra = {}) => ({ type: "user", cwd: "/work/api", gitBranch: "main", entrypoint: "cli", message: { role: "user", content }, ...extra });

jsonl(path.join(root, "claude", "-work-api", "c1.jsonl"), [
  { type: "mode", mode: "normal" },
  claudeUser("<command-name>/clear</command-name>"),
  claudeUser("Fix the login bug"),
  { type: "assistant", message: { content: [{ type: "text", text: "Fixed it." }] } },
  { type: "ai-title", aiTitle: "Login bug" },
]);
jsonl(path.join(root, "claude", "-work-api", "scripted.jsonl"), [claudeUser("run the checks", { entrypoint: "sdk-cli" })]);
jsonl(path.join(root, "codex", "sessions", "2026", "10", "30", "rollout-a.jsonl"), [
  { type: "session_meta", payload: { id: "x1", cwd: "/work/web", thread_source: "user", originator: "codex-tui", git: { branch: "dev" } } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n..." }] } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add dark mode" }] } },
  { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added it." }] } },
]);
jsonl(path.join(root, "codex", "sessions", "2026", "10", "30", "rollout-b.jsonl"), [
  { type: "session_meta", payload: { id: "x2", cwd: "/work/web", thread_source: "subagent" } },
]);
jsonl(path.join(root, "codex", "session_index.jsonl"), [{ id: "x1", thread_name: "dark mode" }, { id: "x1", thread_name: "Dark mode for settings" }]);

test("sessions you started are found with their folder, title and first typed prompt", () => {
  const { sessions } = index();
  const byId = Object.fromEntries(sessions.map((session) => [session.id, session]));
  assert.deepStrictEqual(Object.keys(byId).sort(), ["c1", "x1"], "scripted and subagent sessions are left out");
  assert.strictEqual(byId.c1.title, "Login bug");
  assert.strictEqual(byId.c1.prompt, "Fix the login bug", "a slash-command echo is not a prompt");
  assert.strictEqual(byId.c1.branch, "main");
  assert.strictEqual(byId.x1.title, "Dark mode for settings", "the last rename wins");
  assert.strictEqual(byId.x1.prompt, "Add dark mode", "injected AGENTS.md is not a prompt");
  assert.strictEqual(byId.x1.cwd, "/work/web");
});

test("an unchanged file is not read again, and the cache alone rebuilds the list", () => {
  const { cache } = index();
  const file = path.join(root, "claude", "-work-api", "c1.jsonl");
  cache.files[file].session.title = "from the cache";
  assert.strictEqual(index(cache).sessions.find((s) => s.id === "c1").title, "from the cache");
  assert.deepStrictEqual(fromCache(cache).map((s) => s.id).sort(), ["c1", "x1"]);
  assert.deepStrictEqual(fromCache({ version: 0, files: {} }), []);
});

test("a big session file is read only at its start and end", () => {
  const file = path.join(root, "claude", "-work-big", "big.jsonl");
  const filler = { type: "assistant", message: { content: [{ type: "text", text: "x".repeat(1000) }] } };
  jsonl(file, [claudeUser("Start here", { cwd: "/work/big" }), ...Array(Math.ceil(EDGE_BYTES / 500)).fill(filler), { type: "ai-title", aiTitle: "Late title" }]);
  const big = index().sessions.find((s) => s.id === "big");
  assert.strictEqual(big.prompt, "Start here");
  assert.strictEqual(big.title, "Late title");
});
