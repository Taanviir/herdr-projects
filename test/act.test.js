"use strict";

const test = require("node:test");
const assert = require("node:assert");

// The worker with Herdr answering each call by `answer(args)`.
function worker(answer) {
  const calls = [];
  const herdr = require.resolve("../lib/shared/herdr");
  const real = require(herdr);
  require.cache[herdr].exports = {
    ...real,
    run: (args) => {
      calls.push(args);
      return answer(args) ?? { ok: true, result: {} };
    },
  };
  delete require.cache[require.resolve("../bin/act")];
  const jobs = require("../bin/act");
  require.cache[herdr].exports = real;
  return { jobs, calls };
}

const snapshot = (extra = {}) => ({ ok: true, result: { snapshot: { workspaces: [{ workspace_id: "w2", label: "api" }], panes: [{ pane_id: "w2:p1", workspace_id: "w2", cwd: "/work/api" }], agents: [], ...extra } } });
const created = { ok: true, result: { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } } };
const tab = { ok: true, result: { tab: { tab_id: "w2:t3" }, root_pane: { pane_id: "w2:p4" } } };

test("a folder already open is gone to; one that is not gets a workspace named after it", () => {
  const open = worker((args) => (args[0] === "api" ? snapshot() : null));
  open.jobs.folder({ folder: "/work/api" });
  assert.deepStrictEqual(open.calls.at(-1), ["workspace", "focus", "w2"]);

  const closed = worker((args) => (args[0] === "api" ? snapshot() : null));
  closed.jobs.folder({ folder: "/work/web" });
  assert.deepStrictEqual(closed.calls.at(-1), ["workspace", "create", "--cwd", "/work/web", "--label", "web", "--focus"]);
});

test("a session reopens with its agent's resume flags, in a new tab of the folder's workspace", () => {
  const { jobs, calls } = worker((args) => (args[0] === "api" ? snapshot() : args[0] === "tab" ? tab : null));
  jobs.session({ kind: "codex", id: "x1", folder: "/work/api", cwd: "/work/api" });
  const start = calls.find((args) => args[0] === "agent");
  assert.deepStrictEqual(start.slice(0, 6), ["agent", "start", "pj-codex-w2-p4", "--kind", "codex", "--pane"]);
  assert.deepStrictEqual(start.slice(-2), ["resume", "x1"]);
});

test("a session already running is gone to, never started twice", () => {
  const { jobs, calls } = worker((args) => (args[0] === "api" ? snapshot({ agents: [{ pane_id: "w2:p1", agent_session: { value: "c1" } }] }) : null));
  jobs.session({ kind: "claude", id: "c1", folder: "/work/api", cwd: "/work/api" });
  assert.deepStrictEqual(calls.slice(1), [["agent", "focus", "w2:p1"]]);
});

test("a session that will not start takes the workspace made for it away again", () => {
  const { jobs, calls } = worker((args) => {
    if (args[0] === "api") return snapshot();
    if (args[0] === "workspace" && args[1] === "create") return created;
    if (args[0] === "agent") return { ok: false, code: "agent_exited", message: "claude exited" };
    return null;
  });
  assert.throws(() => jobs.session({ kind: "claude", id: "c1", folder: "/work/web", cwd: "/work/web" }), /claude exited/);
  assert.ok(calls.find((args) => args[0] === "agent").includes("--resume"));
  assert.deepStrictEqual(calls.at(-1), ["workspace", "close", "w9"]);
});
