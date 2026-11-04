"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { verdict, failed, watch } = require("../lib/ci");

const run = (status, conclusion = "", workflowName = "CI") => ({ status, conclusion, workflowName });

test("a commit's runs read as one: any failure fails it, and it passes once all pass", () => {
  assert.strictEqual(verdict([]), null);
  assert.strictEqual(verdict([run("in_progress"), run("completed", "success")]), "running");
  assert.strictEqual(verdict([run("completed", "success"), run("completed", "skipped")]), "pass");
  assert.strictEqual(verdict([run("in_progress"), run("completed", "failure", "Lint")]), "fail", "a failure does not wait for the rest");
  assert.deepStrictEqual(failed([run("completed", "success"), run("completed", "cancelled", "Deploy")]), ["Deploy"]);
});

// Runs answered from `script` one poll at a time, on a clock that moves by
// the poll interval.
function watching(script) {
  let clock = 0;
  const shown = [];
  const result = watch({
    sha: "abc",
    cwd: "/repo",
    runs: () => script[Math.min(clock / 10_000, script.length - 1)],
    show: (state) => shown.push(state),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  });
  return result.then((value) => ({ value, shown }));
}

test("the badge shows running at once, and ends on the verdict", async () => {
  const { value, shown } = await watching([[], [run("queued")], [run("completed", "success")]]);
  assert.strictEqual(value, "pass");
  assert.deepStrictEqual(shown, ["running", "pass"]);
});

test("a commit that never gets runs takes the badge off", async () => {
  const { value, shown } = await watching([[]]);
  assert.strictEqual(value, "none");
  assert.deepStrictEqual(shown, ["running", null]);
});

test("the popup keeps a failure, drops a pass after a day, and a watch that went quiet", () => {
  const { shown } = require("../lib/ci");
  const hour = 60 * 60_000;
  assert.strictEqual(shown({ state: "fail", at: 0 }, 30 * 24 * hour).state, "fail");
  assert.strictEqual(shown({ state: "pass", at: 0 }, 23 * hour).state, "pass");
  assert.strictEqual(shown({ state: "pass", at: 0 }, 25 * hour), null);
  assert.strictEqual(shown({ state: "running", at: 0 }, 2 * hour), null);
});

test("the badge follows the checkout to whichever workspaces have a pane in it", () => {
  const { sidebar } = require("../lib/ci");
  const now = 10 * 60 * 60_000;
  const snapshot = {
    workspaces: [
      { workspace_id: "old", tokens: { ci: "✗ CI" } },
      { workspace_id: "new" },
      { workspace_id: "both", tokens: { ci: "✗ CI" } },
    ],
    panes: [
      { workspace_id: "new", cwd: "/repo/api", foreground_cwd: "/repo/api/src" },
      { workspace_id: "both", cwd: "/repo/api" },
      { workspace_id: "both", cwd: "/repo/web" },
      { workspace_id: "old", cwd: "/repo/api-docs" },
    ],
  };
  const results = {
    "/repo/api": { state: "fail", at: 0 },
    "/repo/web": { state: "pass", at: now - 10 * 60_000 },
  };
  assert.deepStrictEqual(sidebar(snapshot, results, now), [
    { workspace: "old", value: "", ttl: null },
    { workspace: "new", value: "✗ CI", ttl: null },
  ], "the old workspace loses it, the new one gains it, and one already right is left alone");

  const passed = sidebar({ workspaces: [{ workspace_id: "w" }], panes: [{ workspace_id: "w", cwd: "/repo/web" }] }, results, now);
  assert.deepStrictEqual(passed, [{ workspace: "w", value: "✓ CI", ttl: 20 * 60_000 }], "a pass keeps only what is left of its 30 minutes");
});
