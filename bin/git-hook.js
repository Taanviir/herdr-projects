"use strict";

// One-command install: start the CI watch on every `git push` made in a Herdr
// pane. Points git's global core.hooksPath at a folder of hooks that each run
// the repository's own hook first, so repositories keep theirs.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { notify } = require("../lib/shared/herdr");

const MARK = "herdr-projects git hook";
const NAMES = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
  "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge",
  "pre-push", "pre-auto-gc", "post-rewrite", "sendemail-validate", "reference-transaction", "post-index-change",
];

const git = (...args) => spawnSync("git", args, { encoding: "utf8" });

function install(dir, script) {
  const current = git("config", "--global", "--get", "core.hooksPath").stdout.trim();
  if (current && path.resolve(current.replace(/^~/, os.homedir())) !== dir) {
    return [`core.hooksPath is already ${current}, so nothing changed. Copy hooks/dispatch.sh there as pre-push to watch CI on push.`];
  }
  fs.mkdirSync(dir, { recursive: true });
  const kept = [];
  for (const name of NAMES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes(MARK)) {
      kept.push(name);
      continue;
    }
    fs.writeFileSync(file, script, { mode: 0o755 });
  }
  if (!current) git("config", "--global", "core.hooksPath", dir);
  return [
    `git push in a Herdr pane now watches CI (hooks in ${dir})`,
    ...(kept.length ? [`left your own ${kept.join(", ")} alone`] : []),
  ];
}

if (require.main === module) {
  const config = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  const report = install(path.join(config, "git", "hooks"), fs.readFileSync(path.join(__dirname, "..", "hooks", "dispatch.sh"), "utf8"));
  process.stdout.write(`${report.join("\n")}\n`);
  notify("Projects", report.join(" · "), "done");
}

module.exports = { MARK, NAMES, install };
