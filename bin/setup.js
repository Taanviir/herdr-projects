"use strict";

// One-command install: bind the popup in config.toml. Herdr plugins cannot
// register their own keys.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { run, notify, BIN } = require("../lib/shared/herdr");

const PLUGIN_ID = "taanviir.projects";
const BINDINGS = [
  { action: "open", key: process.env.PROJECTS_KEY ?? "prefix+f", description: "Projects" },
];

// `herdr --help` prints the config path it actually uses.
function configPath() {
  const res = spawnSync(BIN, ["--help"], { encoding: "utf8" });
  const match = /^Config:\s*(.+)$/m.exec(res.stdout ?? "");
  if (match) return match[1].trim();
  const base = process.env.APPDATA ?? path.join(os.homedir(), ".config");
  return path.join(base, "herdr", "config.toml");
}

function bindKeys(report) {
  const file = configPath();
  let config = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const blocks = [];
  for (const { action, key, description } of BINDINGS) {
    const command = `${PLUGIN_ID}.${action}`;
    if (config.includes(`"${command}"`)) {
      report.push(`${description} is already bound`);
      continue;
    }
    // Do not quietly shadow a key that is already in use.
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^\\s*(key\\s*=|[a-z_]+\\s*=)\\s*(["'])${escaped}\\2`, "m").test(config)) {
      report.push(`${key} is taken, so ${description} is unbound`);
      continue;
    }
    blocks.push(`\n[[keys.command]]\nkey = "${key}"\ntype = "plugin_action"\ncommand = "${command}"\ndescription = "${description}"\n`);
    report.push(`${key}: ${description}`);
  }
  if (!blocks.length) return;

  if (config) fs.copyFileSync(file, `${file}.bak-projects`);
  else fs.mkdirSync(path.dirname(file), { recursive: true });
  if (config && !config.endsWith("\n")) config += "\n";
  fs.writeFileSync(file, `${config}${blocks.join("")}`);

  const reloaded = run(["server", "reload-config"], { check: false });
  if (!reloaded.ok) report.push(`config reload failed: ${reloaded.message}`);
}

const report = [];
bindKeys(report);
const message = report.join("\n");
process.stdout.write(`${message}\n`);
notify("Projects", report.join(" · "), "done");
