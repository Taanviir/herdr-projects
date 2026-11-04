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
