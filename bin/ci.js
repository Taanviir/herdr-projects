"use strict";

// Action entrypoint: watch CI for the commit the focused pane's folder is on,
// on the workspace's `$ci` sidebar token. The watching is a detached copy of
// this script, so the action returns at once. One watch per workspace: a new
// one replaces the old.

const fs = require("node:fs");
const path = require("node:path");
const { run, notify, spawnDetached } = require("../lib/shared/herdr");
const { context, STATE_DIR } = require("../lib/shared/term");
const { SOURCE, BADGES, PASS_TTL_MS, failed, sh, watch, remember } = require("../lib/ci");

const RESULTS = path.join(STATE_DIR, "ci.json");

const pidFile = (workspace) => path.join(STATE_DIR, `ci-${workspace.replace(/[^\w-]/g, "_")}.pid`);

function start() {
  const ctx = context();
  const cwd = ctx.focused_pane_cwd ?? ctx.workspace_cwd;
  const workspace = ctx.workspace_id;
  if (!cwd || !workspace) return;
  const sha = sh("git", ["rev-parse", "HEAD"], cwd);
  if (!sha) {
    notify("CI", `${path.basename(cwd)} is not a git checkout`);
    return;
  }
  spawnDetached(process.execPath, [__filename, "--watch", workspace, cwd, sha]);
}

function show(workspace, state) {
  const args = ["workspace", "report-metadata", workspace, "--source", SOURCE];
  if (!state) args.push("--clear-token", "ci");
  else args.push("--token", `ci=${BADGES[state]}`);
  if (state === "pass") args.push("--ttl-ms", String(PASS_TTL_MS));
  run(args, { check: false });
}

async function watching(workspace, cwd, sha) {
  const file = pidFile(workspace);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    const pid = Number(fs.readFileSync(file, "utf8"));
    // A stale file's pid may belong to something else by now.
    if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(__filename)) process.kill(pid);
  } catch { /* none running */ }
  fs.writeFileSync(file, String(process.pid));

  const checkout = sh("git", ["rev-parse", "--show-toplevel"], cwd) ?? cwd;
  const name = path.basename(checkout);
  let runs = [];
  const result = await watch({
    sha,
    cwd,
    show: (state, found) => {
      runs = found;
      show(workspace, state);
      remember(RESULTS, checkout, state && { state, sha, failed: failed(found), at: Date.now() });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  if (result === "pass") notify("CI passed", name, "done");
  if (result === "fail") notify("CI failed", `${name}: ${failed(runs).join(", ")}`);
  if (result === "none") notify("No CI runs", `${name} @ ${sha.slice(0, 7)}: not pushed, or no workflow runs on it`);
  if (result === "timeout") notify("CI still running", `${name}: stopped watching after an hour`);

  try {
    if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file);
  } catch { /* replaced */ }
}

if (process.argv[2] === "--watch") watching(...process.argv.slice(3));
else start();
