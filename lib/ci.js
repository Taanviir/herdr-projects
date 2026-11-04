"use strict";

// CI on Herdr's sidebar: after a push, the workspace's `$ci` token follows the
// GitHub Actions runs for the commit you are on until they finish. It shows
// wherever [ui.sidebar.spaces] rows in config.toml name it.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SOURCE = "taanviir.projects";
const POLL_MS = 10_000;
// A push takes a few seconds to show up as runs, and a commit no workflow
// runs on never does.
const APPEAR_MS = 90_000;
const GIVE_UP_MS = 60 * 60_000;
const PASS_TTL_MS = 30 * 60_000;

const BADGES = { running: "● CI", pass: "✓ CI", fail: "✗ CI" };

// All of a commit's runs, as one: failed if any failed, passed once all pass.
function verdict(runs) {
  if (!runs.length) return null;
  if (runs.some((run) => run.status === "completed" && !["success", "skipped", "neutral"].includes(run.conclusion))) return "fail";
  return runs.every((run) => run.status === "completed") ? "pass" : "running";
}

function failed(runs) {
  return runs.filter((run) => run.status === "completed" && !["success", "skipped", "neutral"].includes(run.conclusion)).map((run) => run.workflowName);
}

function sh(command, args, cwd) {
  const res = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 20_000 });
  return res.status === 0 ? res.stdout.trim() : null;
}

function commitRuns(sha, cwd) {
  const out = sh("gh", ["run", "list", "--commit", sha, "--json", "status,conclusion,workflowName", "--limit", "20"], cwd);
  try {
    return out === null ? null : JSON.parse(out);
  } catch {
    return null;
  }
}

// `show(verdict, runs)` puts it on the sidebar: running from the start, then
// pass or fail, or null to take it off when there turns out to be no CI.
async function watch({ sha, cwd, show, runs = commitRuns, sleep, now = Date.now }) {
  const started = now();
  show("running", []);
  for (;;) {
    const found = runs(sha, cwd) ?? [];
    const state = verdict(found);
    if (state === "pass" || state === "fail") {
      show(state, found);
      return state;
    }
    const waited = now() - started;
    if ((!state && waited > APPEAR_MS) || waited > GIVE_UP_MS) {
      show(null, found);
      return state ? "timeout" : "none";
    }
    await sleep(POLL_MS);
  }
}

// The last watch's outcome for each checkout, for the Projects popup: path ->
// { state, sha, failed, at }.
function results(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function remember(file, checkout, entry) {
  const all = results(file);
  if (entry) all[checkout] = entry;
  else delete all[checkout];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(all));
  fs.renameSync(temp, file);
}

// What the popup shows: a running watch that has not reported in an hour
// died, and a pass is old news after a day. A failure stays until the next
// watch.
function shown(entry, now = Date.now()) {
  if (!entry) return null;
  const age = now - entry.at;
  if (entry.state === "running" && age > 65 * 60_000) return null;
  if (entry.state === "pass" && age > 24 * 60 * 60_000) return null;
  return entry;
}

module.exports = { SOURCE, BADGES, PASS_TTL_MS, verdict, failed, sh, watch, results, remember, shown };
