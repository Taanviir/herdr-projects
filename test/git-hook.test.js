"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "hooks", "dispatch.sh"), "utf8");

const made = [];
test.after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pj-hook-"));
  made.push(dir);
  const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args, cwd = dir, extra = {}) => spawnSync("git", args, { cwd, env: { ...env, ...extra }, encoding: "utf8" });
  return { dir, env, git };
}

// install() talks to git through process.env, so point it at the sandbox.
function installIn(box, hooks) {
  const saved = { ...process.env };
  Object.assign(process.env, box.env);
  try {
    delete require.cache[require.resolve("../bin/git-hook")];
    return require("../bin/git-hook").install(hooks, SCRIPT);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test("install sets the global hooks folder, keeps a hook of yours, and leaves another hooksPath alone", () => {
  const box = sandbox();
  const hooks = path.join(box.dir, "hooks");
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho mine\n");
  const report = installIn(box, hooks);
  assert.strictEqual(box.git(["config", "--global", "core.hooksPath"]).stdout.trim(), hooks);
  assert.match(fs.readFileSync(path.join(hooks, "pre-push"), "utf8"), /herdr-projects git hook/);
  assert.strictEqual(fs.readFileSync(path.join(hooks, "pre-commit"), "utf8"), "#!/bin/sh\necho mine\n");
  assert.match(report.join("\n"), /left your own pre-commit alone/);

  const other = sandbox();
  other.git(["config", "--global", "core.hooksPath", "/elsewhere"]);
  assert.match(installIn(other, path.join(other.dir, "hooks")).join("\n"), /already \/elsewhere/);
  assert.ok(!fs.existsSync(path.join(other.dir, "hooks")));
});

test("a push in a Herdr pane starts the watch for the pushed commit, and the repository's own hooks still run", () => {
  const box = sandbox();
  const hooks = path.join(box.dir, "hooks");
  installIn(box, hooks);

  // A stand-in plugin whose ci.js logs how it was started.
  const log = path.join(box.dir, "log");
  const root = path.join(box.dir, "plugin");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "ci.js"), `require("fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");`);
  const herdr = path.join(box.dir, "herdr");
  const list = JSON.stringify({ result: { plugins: [{ plugin_id: "taanviir.projects", plugin_root: root }] } });
  fs.writeFileSync(herdr, `#!/bin/sh\necho '${list}'\n`, { mode: 0o755 });

  const remote = path.join(box.dir, "remote.git");
  const repo = path.join(box.dir, "repo");
  box.git(["init", "-q", "--bare", remote]);
  box.git(["init", "-q", repo]);
  for (const args of [["config", "user.email", "t@t"], ["config", "user.name", "t"], ["remote", "add", "origin", remote]]) box.git(args, repo);
  fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-push"), `#!/bin/sh\ncat > ${JSON.stringify(path.join(box.dir, "own"))}\n`, { mode: 0o755 });
  box.git(["commit", "-q", "--allow-empty", "-m", "one"], repo);
  const sha = box.git(["rev-parse", "HEAD"], repo).stdout.trim();

  const pushed = box.git(["push", "-q", "origin", "HEAD:main"], repo, { HERDR_WORKSPACE_ID: "w7", HERDR_BIN_PATH: herdr });
  assert.strictEqual(pushed.status, 0, pushed.stderr);
  const started = Date.now();
  while (!fs.existsSync(log) && Date.now() - started < 5000) spawnSync("sleep", ["0.05"]);
  assert.strictEqual(fs.readFileSync(log, "utf8").trim(), `--watch w7 ${repo} ${sha}`);
  assert.match(fs.readFileSync(path.join(box.dir, "own"), "utf8"), new RegExp(`^HEAD ${sha} refs/heads/main `), "the repository's pre-push got git's input");
});
