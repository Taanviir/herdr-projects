"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkouts, folders, owner } = require("../lib/folders");
const { score } = require("../lib/fuzzy");
const { workspaceFor, paneRunning } = require("../lib/place");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "projects-folders-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
for (const dir of ["a/.git", "a/inner/.git", "group/b/.git", "group/node_modules/c/.git", ".hidden/d/.git", "plain"]) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}

test("checkouts are found under a root, without looking inside one or in hidden and build folders", () => {
  assert.deepStrictEqual(checkouts(root).map((dir) => path.relative(root, dir)).sort(), ["a", "group/b"]);
});

test("a session counts toward the checkout it ran in; one whose folder is gone is not kept", () => {
  const repos = ["/work/api", "/work/api/vendor/lib"];
  assert.strictEqual(owner("/work/api/src", repos), "/work/api");
  assert.strictEqual(owner("/work/api/vendor/lib/x", repos), "/work/api/vendor/lib");
  assert.strictEqual(owner("/work/apis", repos), "/work/apis", "a sibling with a longer name is not inside");

  const sessions = [
    { id: "1", cwd: "/work/api/src", updated: 5 },
    { id: "2", cwd: "/scratch", updated: 9 },
    { id: "3", cwd: "/gone", updated: 7 },
  ];
  const list = folders(sessions, ["/work/api", "/work/idle"], (dir) => dir !== "/gone");
  assert.deepStrictEqual(list.map((f) => [f.path, f.sessions.length, f.updated]), [["/scratch", 1, 9], ["/work/api", 1, 5], ["/work/idle", 0, 0]]);
  assert.deepStrictEqual(sessions.map((s) => s.folder), ["/work/api", "/scratch", undefined]);
});

test("search wants every word's letters in order, and favours whole words and word starts", () => {
  assert.strictEqual(score("hqp", "herdr-quick-prompt"), score("hqp", "herdr-quick-prompt"));
  assert.ok(score("quick", "herdr-quick-prompt") > score("qik", "herdr-quick-prompt"));
  assert.ok(score("api login", "Login bug /work/api") !== null);
  assert.strictEqual(score("api zebra", "Login bug /work/api"), null);
  assert.strictEqual(score("", "anything"), 0);
});

test("the workspace for a folder is the one with most panes in it, and a running session is found by id", () => {
  const snapshot = {
    workspaces: [{ workspace_id: "w1", label: "misc" }, { workspace_id: "w2", label: "api" }],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", cwd: "/work/api" },
      { pane_id: "w2:p1", workspace_id: "w2", cwd: "/work/api/src" },
      { pane_id: "w2:p2", workspace_id: "w2", cwd: "/work/api", foreground_cwd: "/work/api/test" },
      { pane_id: "w3:p1", workspace_id: "w3", cwd: "/work/apis" },
    ],
    agents: [{ pane_id: "w2:p1", agent_session: { value: "abc" } }],
  };
  assert.strictEqual(workspaceFor(snapshot, "/work/api"), "w2");
  assert.strictEqual(workspaceFor(snapshot, "/elsewhere"), null);
  assert.strictEqual(workspaceFor(null, "/work/api"), null);
  assert.strictEqual(paneRunning(snapshot, "abc"), "w2:p1");
  assert.strictEqual(paneRunning(snapshot, "zzz"), null);
});
