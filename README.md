# Projects

A [Herdr](https://herdr.dev) plugin for getting back to your work. One popup:
your projects on the left, most recent first, and the selected project's past
Claude Code and Codex sessions on the right.

```
Prompt   Notes   Projects                                  66 projects · 1 running
› search projects and sessions…
───────────────────────────────────┬──────────────────────────────────────────────
┃  budgit                 :3000 1d │ ~/projects/personal/budgit
  ● work-thing                 13m │ ▶ pnpm dev :3000                    2h · 280 MB
  ● analysis                    1d │
    herdr-quick-prompt         27d │  ✻ Cloudflare usage for this application    1d
                                   │  ✻ Open issues                              3d
⏎ opens a workspace here · ctrl+o opens :3000 · ctrl+x stops it
```

- **Projects** are the git checkouts under `~/projects`, and every other folder
  you have run an agent in. `⏎` goes to the workspace already working there, or
  opens a new one named after the folder. A green `●` means one is open.
- **Sessions:** `tab` steps into the selected project's sessions. `⏎` reopens
  one in its own folder, in a new tab of that project's workspace. One still
  running is gone to, never started twice. The line at the bottom shows what it
  was about.
- **Dev servers:** a project with a server running shows its port. `ctrl+o`
  opens it in your browser and `ctrl+x` twice stops it, with everything it
  started.
- **Search** matches project names loosely and sessions by the words in their
  title or first prompt.

| Key | |
| --- | --- |
| type | search |
| `↑` `↓`, `pgup` `pgdn` | choose |
| `tab` | step into the project's sessions, and back |
| `⏎` | go to the project, or reopen the session |
| `ctrl+n` | start a new agent in the project, through [Quick Prompt](https://github.com/Taanviir/herdr-quick-prompt) |
| `ctrl+o` | open the project's dev server in your browser |
| `ctrl+x`, `ctrl+x` | stop it |
| `alt+←` `alt+→` | switch to Prompt or Notes, keeping the project |
| `esc` | out of the sessions, clear the search, then close |

Sessions started by a script (the Agent SDK, `codex exec`) or by another agent
(subagents, reviews) are left out, and so are sessions whose folder is gone.
Finding dev servers needs Linux or WSL: it reads `/proc` and asks `ss` which
process holds which port.

## Install

```bash
herdr plugin install Taanviir/herdr-projects
herdr plugin action invoke taanviir.projects.setup
```

Setup binds `prefix+f`. Set `PROJECTS_KEY` first to use another key. A key
that is already bound is left alone.

To look for checkouts somewhere other than `~/projects`, add `config.json` to
the plugin's config directory (`herdr plugin config-dir taanviir.projects`):

```json
{ "roots": ["~/projects", "~/work"] }
```

## How it reads your history

Claude Code keeps sessions in `~/.claude/projects`, and Codex in
`~/.codex/sessions` with names in `~/.codex/session_index.jsonl`. A session
file can be tens of megabytes, so only its first and last 256 KB are read, and
the result is cached in the plugin's state directory until the file changes.
The popup opens on the cache and brings it up to date in a background thread.
Nothing is written to either agent's files.

## Files

| Path | |
| --- | --- |
| plugin state dir, `sessions.json` | the session index |
| plugin state dir, `crash.log` | errors from the popup |

## Developing

```bash
herdr plugin link .
npm test
```

| File | |
| --- | --- |
| `bin/open.js` | the key: opens the popup |
| `bin/picker.js` | the popup: projects, their sessions and servers, keys |
| `bin/act.js` | detached worker that goes to a folder, reopens a session, or opens Quick Prompt |
| `lib/sessions.js` | reading Claude Code and Codex sessions, and the cache |
| `lib/indexer.js` | runs the index off the popup's thread |
| `lib/folders.js` | checkouts under the roots, and which folder a session belongs to |
| `lib/place.js` | which workspace is open in a folder, and where a session is running |
| `lib/fuzzy.js` | the search |
| `lib/procs.js` | listening ports from `ss`, and processes from `/proc` |
| `lib/servers.js` | grouping processes into dev servers |
| `lib/open.js` | the command that opens a URL in your browser |

`lib/shared/` is copied from Quick Prompt. Edit it there and run its
`tools/sync-shared.js`; `test/shared.test.js` fails here until you do.

## License

MIT
