#!/bin/sh
# herdr-projects git hook. Git reads hooks from one folder only, so this one
# file is installed under every hook name there: it runs the repository's own
# hook of the same name, and on pre-push inside Herdr also starts the CI watch
# for the commit being pushed.

name=$(basename "$0")
# Filled in on install: a push runs outside Herdr, which only tells the
# plugin's own commands where its state lives.
state_dir=@STATE_DIR@
# Not --git-path: that answers with the global hooks folder, this one.
own="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/$name"

if [ "$name" = pre-push ]; then
  input=$(cat)
  if [ -n "$HERDR_WORKSPACE_ID" ] && command -v node >/dev/null 2>&1; then
    sha=$(printf '%s\n' "$input" | awk '$2 !~ /^0+$/ { print $2; exit }')
    root=$("${HERDR_BIN_PATH:-herdr}" plugin list --json 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const j=JSON.parse(s);const p=(j.result??j).plugins.find((p)=>p.plugin_id==="taanviir.projects"&&p.enabled!==false);if(p)console.log(p.plugin_root)}catch{}})')
    if [ -n "$sha" ] && [ -f "$root/bin/ci.js" ]; then
      (env ${state_dir:+"HERDR_PLUGIN_STATE_DIR=$state_dir"} node "$root/bin/ci.js" --watch "$PWD" "$sha" >/dev/null 2>&1 &)
    fi
  fi
  if [ -x "$own" ]; then
    { [ -n "$input" ] && printf '%s\n' "$input"; } | "$own" "$@"
    exit $?
  fi
  exit 0
fi

if [ -x "$own" ]; then
  exec "$own" "$@"
fi
exit 0
