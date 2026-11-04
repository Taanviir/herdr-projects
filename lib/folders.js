"use strict";

// Where you can work: the git checkouts under your project roots, and every
// other folder a session ran in. A session started inside a checkout counts
// toward that checkout, so `~/app/src` and `~/app` are one project.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_ROOTS = ["~/projects"];
const MAX_DEPTH = 3;
const SKIP = new Set(["node_modules", "vendor", "target", "dist", "build"]);

const expand = (dir) => (dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir);

// `config.json` in the plugin's config directory: { "roots": ["~/projects", "~/work"] }.
function roots() {
  try {
    const file = path.join(process.env.HERDR_PLUGIN_CONFIG_DIR ?? "", "config.json");
    const configured = JSON.parse(fs.readFileSync(file, "utf8")).roots;
    if (Array.isArray(configured) && configured.length) return configured.map(expand);
  } catch { /* no config yet */ }
  return DEFAULT_ROOTS.map(expand);
}

// A folder with a .git in it is a checkout, and nothing below it is looked at.
function checkouts(root, depth = MAX_DEPTH) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((entry) => entry.name === ".git")) return [root];
  if (depth === 0) return [];
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name))
    .flatMap((entry) => checkouts(path.join(root, entry.name), depth - 1));
}

const inside = (dir, folder) => dir === folder || dir.startsWith(folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`);

// The deepest known checkout holding `dir`, or `dir` itself.
function owner(dir, repos) {
  let best = null;
  for (const repo of repos) if (inside(dir, repo) && (!best || repo.length > best.length)) best = repo;
  return best ?? dir;
}

// Newest first. A checkout no session has touched sorts last, by name. Each
// session is marked with the folder it belongs to; one whose folder is gone
// is left unmarked, since it cannot be reopened.
function folders(sessions, repos, exists = fs.existsSync) {
  const byPath = new Map(repos.map((repo) => [repo, { path: repo, name: path.basename(repo), repo: true, sessions: [], updated: 0 }]));
  for (const session of sessions) {
    const at = owner(session.cwd, repos);
    if (!byPath.has(at)) {
      if (!exists(at)) continue;
      byPath.set(at, { path: at, name: path.basename(at) || at, repo: false, sessions: [], updated: 0 });
    }
    const folder = byPath.get(at);
    session.folder = at;
    folder.sessions.push(session);
    folder.updated = Math.max(folder.updated, session.updated);
  }
  return [...byPath.values()].sort((a, b) => b.updated - a.updated || a.name.localeCompare(b.name));
}

module.exports = { roots, checkouts, owner, folders, inside };
