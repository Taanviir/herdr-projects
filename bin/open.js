"use strict";

// Action entrypoint: open the popup where you are. Bound to a key through
// [[keys.command]] in config.toml.

const { run } = require("../lib/shared/herdr");
const { context } = require("../lib/shared/term");
const { TABS, envFor } = require("../lib/shared/tabs");

const ctx = context();
const where = { cwd: ctx.focused_pane_cwd ?? ctx.workspace_cwd, workspace: ctx.workspace_id, pane: ctx.focused_pane_id };
const args = ["plugin", "pane", "open", "--plugin", "taanviir.projects", "--entrypoint", "picker"];
for (const [key, value] of Object.entries(envFor(TABS.find((tab) => tab.id === "projects"), where))) args.push("--env", `${key}=${value}`);
const res = run(args, { check: false });
if (res.ok === false) {
  process.stderr.write(`${res.message}\n`);
  process.exit(1);
}
