"use strict";

// CI on Herdr's sidebar: after a push, the `$ci` token follows the GitHub
// Actions runs for the pushed commit until they finish. A result belongs to
// the checkout, so the token goes on every workspace with a pane in it, and
// moves when they do. It shows wherever [ui.sidebar.spaces] rows in
// config.toml name it.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { inside } = require("./folders");
const { run } = require("./shared/herdr");

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

// A running watch that has not reported in an hour died, and a pass is old
// news after `passFor`. A failure stays until the next watch.
function shown(entry, now = Date.now(), passFor = 24 * 60 * 60_000) {
  if (!entry) return null;
  const age = now - entry.at;
  if (entry.state === "running" && age > 65 * 60_000) return null;
  if (entry.state === "pass" && age > passFor) return null;
  return entry;
}

const WORST = ["fail", "running", "pass"];

// The `$ci` token each workspace should have, for those whose token differs:
// [{ workspace, value, ttl }], an empty value clearing it. A workspace with
// panes in several checkouts shows the worst of them.
function sidebar(snapshot, all, now = Date.now()) {
  const live = Object.entries(all).flatMap(([checkout, entry]) => {
    const kept = shown(entry, now, PASS_TTL_MS);
    return kept ? [{ checkout, ...kept }] : [];
  });
  return (snapshot?.workspaces ?? []).flatMap(({ workspace_id: workspace, tokens }) => {
    const folders = (snapshot.panes ?? []).filter((pane) => pane.workspace_id === workspace).map((pane) => pane.foreground_cwd ?? pane.cwd).filter(Boolean);
    const here = live.filter(({ checkout }) => folders.some((folder) => inside(folder, checkout)));
    const top = here.sort((a, b) => WORST.indexOf(a.state) - WORST.indexOf(b.state))[0];
    const value = top ? BADGES[top.state] : "";
    if ((tokens?.ci ?? "") === value) return [];
    return [{ workspace, value, ttl: top?.state === "pass" ? PASS_TTL_MS - (now - top.at) : null }];
  });
}

function report(file) {
  const res = run(["api", "snapshot"], { check: false, timeout: 3000 });
  if (!res.ok) return;
  for (const { workspace, value, ttl } of sidebar(res.result.snapshot, results(file))) {
    const args = ["workspace", "report-metadata", workspace, "--source", SOURCE, ...(value ? ["--token", `ci=${value}`] : ["--clear-token", "ci"])];
    if (ttl) args.push("--ttl-ms", String(Math.round(ttl)));
    run(args, { check: false });
  }
}

module.exports = { SOURCE, BADGES, PASS_TTL_MS, verdict, failed, sh, watch, results, remember, shown, sidebar, report };
