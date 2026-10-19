#!/usr/bin/env bash
# Set up jarbobo on this machine, or prepare a codebase for it.
#
#   ./setup.sh [install]      build the extension, install it into VS Code /
#                             Cursor, register the MCP server with Claude Code
#                             (and Cursor), link the onboarding skill
#   ./setup.sh project [DIR]  prepare a codebase (default: current dir):
#                             keep *.jarbobo diagrams out of `git status`
#   ./setup.sh check          show what is installed and where
#
# Options:  --dry-run           print the commands instead of running them
#           --editor code|cursor|all|none   which editors get the extension
#                                           (default: every one found)
#
# On a fresh machine, without a checkout:
#   curl -fsSL https://raw.githubusercontent.com/joelchongg/jarbobo/main/setup.sh | bash
# clones into $JARBOBO_DIR (default ~/jarbobo) from $JARBOBO_REPO, then installs.

set -euo pipefail

JARBOBO_REPO="${JARBOBO_REPO:-https://github.com/joelchongg/jarbobo.git}"
NODE_MIN_MAJOR=18

DRY_RUN=0
EDITOR_CHOICE=all
CMD=""
CMD_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --editor)  EDITOR_CHOICE="${2:?--editor needs code|cursor|all|none}"; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    install|project|check)
      [ -z "$CMD" ] || { echo "only one command at a time" >&2; exit 2; }
      CMD="$1" ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *)  [ "$CMD" = project ] && [ -z "$CMD_ARG" ] || { echo "unexpected argument: $1" >&2; exit 2; }
        CMD_ARG="$1" ;;
  esac
  shift
done
CMD="${CMD:-install}"

# ---- output helpers -------------------------------------------------------

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else B=; G=; Y=; R=; N=; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
run()  {
  if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*" >&2; else "$@"; fi
}

# ---- locating things -------------------------------------------------------

# The checkout this script belongs to, or empty when piped through curl.
repo_root() {
  local src="${BASH_SOURCE[0]:-}"
  [ -n "$src" ] && [ -f "$src" ] || return 0
  local dir; dir="$(cd "$(dirname "$src")" && pwd)"
  if [ -f "$dir/package.json" ] && grep -q '"name": "jarbobo"' "$dir/package.json"; then
    echo "$dir"
  fi
}

find_node() {
  command -v node || true
}

node_major() {
  "$1" -p 'process.versions.node.split(".")[0]'
}

# Editor CLIs, including the macOS app-bundle locations that are not on PATH
# until "Shell Command: Install 'code' command in PATH" has been run.
find_editor_cli() {
  case "$1" in
    code)
      command -v code && return
      for p in "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
               "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
        [ -x "$p" ] && { echo "$p"; return; }
      done ;;
    cursor)
      command -v cursor && return
      for p in "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
               "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor"; do
        [ -x "$p" ] && { echo "$p"; return; }
      done ;;
  esac
  return 0
}

ext_id() {
  "$NODE" -p 'const p=require(process.argv[1]); p.publisher+"."+p.name' "$ROOT/package.json"
}

ext_version() {
  "$NODE" -p 'require(process.argv[1]).version' "$ROOT/package.json"
}

# ---- install ----------------------------------------------------------------

check_prereqs() {
  step "Checking prerequisites"
  command -v git >/dev/null || die "git is not installed"
  NODE="$(find_node)"
  [ -n "$NODE" ] || die "node is not installed (need ${NODE_MIN_MAJOR}+; e.g. brew install node)"
  local major; major="$(node_major "$NODE")"
  [ "$major" -ge "$NODE_MIN_MAJOR" ] || die "node $major found at $NODE; need ${NODE_MIN_MAJOR}+"
  command -v npm >/dev/null || die "npm is not installed"
  ok "node $("$NODE" --version) at $NODE"
}

ensure_checkout() {
  ROOT="$(repo_root)"
  if [ -n "$ROOT" ]; then
    ok "using checkout $ROOT"
    return
  fi
  ROOT="${JARBOBO_DIR:-$HOME/jarbobo}"
  if [ -d "$ROOT/.git" ]; then
    ok "using existing checkout $ROOT"
  else
    step "Cloning $JARBOBO_REPO into $ROOT"
    run git clone "$JARBOBO_REPO" "$ROOT"
  fi
}

build() {
  step "Building"
  cd "$ROOT"
  # npm ci keeps package-lock.json exact; fall back if the lock is out of sync.
  run npm ci --no-audit --no-fund || run npm install --no-audit --no-fund
  run npm run --silent compile
  run npm run --silent vendor >/dev/null
  VSIX="$ROOT/jarbobo-$(ext_version).vsix"
  run npx --no-install vsce package --allow-missing-repository -o "$VSIX" >/dev/null
  ok "built $VSIX"
  SERVER="$ROOT/out/mcp-server.js"
  [ "$DRY_RUN" = 1 ] || [ -f "$SERVER" ] || die "build did not produce $SERVER"
}

install_extension() {
  step "Installing the editor extension"
  local found=0 ed cli
  for ed in code cursor; do
    [ "$EDITOR_CHOICE" = all ] || [ "$EDITOR_CHOICE" = "$ed" ] || continue
    cli="$(find_editor_cli "$ed")"
    if [ -z "$cli" ]; then
      [ "$EDITOR_CHOICE" = "$ed" ] && die "$ed CLI not found"
      continue
    fi
    found=1
    run "$cli" --install-extension "$VSIX" --force >/dev/null
    ok "$ed: installed $(ext_id) $(ext_version) (reload the window to pick it up)"
  done
  if [ "$EDITOR_CHOICE" = none ]; then
    ok "skipped (--editor none)"
  elif [ "$found" = 0 ]; then
    warn "no VS Code or Cursor CLI found; install manually: code --install-extension $VSIX"
  fi
}

# VS Code registers the server itself (mcpServerDefinitionProviders). Claude Code
# and Cursor need it registered by hand. Use node's absolute path: GUI-launched
# clients often lack the shell's PATH.
register_mcp() {
  step "Registering the MCP server"
  if command -v claude >/dev/null; then
    run claude mcp remove jarbobo -s user >/dev/null 2>&1 || true
    run claude mcp add jarbobo -s user -- "$NODE" "$SERVER" >/dev/null
    ok "Claude Code (user scope): $NODE $SERVER"
  else
    warn "claude CLI not found; later run: claude mcp add jarbobo -s user -- $NODE $SERVER"
  fi

  if [ -n "$(find_editor_cli cursor)" ] || [ -d "$HOME/.cursor" ]; then
    local cfg="$HOME/.cursor/mcp.json"
    if [ "$DRY_RUN" = 1 ]; then
      printf '  [dry-run] set mcpServers.jarbobo in %s\n' "$cfg"
    elif "$NODE" -e '
        const fs = require("fs"), path = require("path");
        const [cfg, node, server] = process.argv.slice(1);
        let c = {};
        if (fs.existsSync(cfg)) {
          try { c = JSON.parse(fs.readFileSync(cfg, "utf8")); }
          catch { process.exit(3); }   // JSONC or hand-edited: leave it alone
        }
        c.mcpServers = c.mcpServers || {};
        c.mcpServers.jarbobo = { command: node, args: [server] };
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        fs.writeFileSync(cfg, JSON.stringify(c, null, 2) + "\n");
      ' "$cfg" "$NODE" "$SERVER"; then
      ok "Cursor: $cfg"
    else
      warn "could not parse $cfg; add jarbobo to it by hand (see README)"
    fi
  fi
}

# Symlink, so pulling the repo updates the skill too.
link_skill() {
  step "Linking the codebase-onboarding skill"
  local src="$ROOT/skills/codebase-onboarding" dst="$HOME/.claude/skills/codebase-onboarding"
  [ -d "$src" ] || { warn "no skill at $src; skipped"; return; }
  if [ -L "$dst" ]; then
    run ln -sfn "$src" "$dst"
  elif [ -e "$dst" ]; then
    warn "$dst exists and is not a link; left alone (remove it to use the repo's copy)"
    return
  else
    run mkdir -p "$(dirname "$dst")"
    run ln -s "$src" "$dst"
  fi
  ok "$dst -> $src"
}

# Handshake with the server and list its tools; draws nothing.
verify_server() {
  step "Checking the MCP server starts"
  [ "$DRY_RUN" = 0 ] || { printf '  [dry-run] skipped\n'; return; }
  local tools
  tools="$("$NODE" -e '
    const { spawn } = require("child_process");
    const p = spawn(process.execPath, [process.argv[1]], { stdio: ["pipe", "pipe", "ignore"] });
    const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n").slice(0, -1)) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ method: "notifications/initialized" }); send({ id: 2, method: "tools/list" }); }
        if (m.id === 2) { console.log(m.result.tools.map((t) => t.name).join(", ")); p.kill(); process.exit(0); }
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    });
    setTimeout(() => { p.kill(); process.exit(1); }, 10000);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "setup", version: "0" } } });
  ' "$SERVER")" || die "MCP server did not answer; try: node $SERVER"
  ok "tools: $tools"
}

cmd_install() {
  check_prereqs
  ensure_checkout
  build
  install_extension
  register_mcp
  link_skill
  verify_server
  step "Done"
  echo "  Restart Claude Code and reload your editor window."
  echo "  For each codebase you study:  $ROOT/setup.sh project <dir>"
}

# ---- project ----------------------------------------------------------------

cmd_project() {
  local dir="${CMD_ARG:-$PWD}"
  [ -d "$dir" ] || die "no such directory: $dir"
  dir="$(cd "$dir" && pwd)"
  step "Preparing $dir"

  # Diagrams are saved next to the code they describe. Keep them out of
  # `git status` without touching the project's tracked .gitignore.
  if git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
    local exclude; exclude="$(cd "$dir" && git rev-parse --git-path info/exclude)"
    case "$exclude" in /*) ;; *) exclude="$dir/$exclude" ;; esac
    if grep -qxF '*.jarbobo' "$exclude" 2>/dev/null; then
      ok "*.jarbobo already in $exclude"
    else
      if [ "$DRY_RUN" = 1 ]; then
        printf '  [dry-run] append *.jarbobo to %s\n' "$exclude"
      else
        mkdir -p "$(dirname "$exclude")"
        printf '\n# jarbobo diagrams (local only)\n*.jarbobo\n' >> "$exclude"
      fi
      ok "*.jarbobo added to $exclude (local, not committed)"
    fi
  else
    warn "not a git repository; nothing to exclude"
  fi

  command -v claude >/dev/null && claude mcp get jarbobo >/dev/null 2>&1 \
    || warn "jarbobo MCP server not registered with Claude Code; run: setup.sh install"

  step "Next"
  echo "  cd $dir && code . && claude"
  echo "  Then ask: \"I'm new to this codebase. Onboard me: what is it for, where do I start?\""
}

# ---- check ------------------------------------------------------------------

cmd_check() {
  step "jarbobo status"
  NODE="$(find_node)"
  [ -n "$NODE" ] && ok "node $("$NODE" --version) at $NODE" || warn "node not found"

  ROOT="$(repo_root)"
  [ -n "$ROOT" ] && ok "checkout $ROOT ($(git -C "$ROOT" rev-parse --abbrev-ref HEAD)@$(git -C "$ROOT" rev-parse --short HEAD))" \
                 || warn "not run from a checkout"

  local ed cli
  for ed in code cursor; do
    cli="$(find_editor_cli "$ed")"
    [ -n "$cli" ] || continue
    local line; line="$("$cli" --list-extensions --show-versions 2>/dev/null | grep -i '\.jarbobo@' || true)"
    [ -n "$line" ] && ok "$ed extension: $line" || warn "$ed: extension not installed"
  done

  if command -v claude >/dev/null; then
    local server; server="$(claude mcp get jarbobo 2>/dev/null | sed -n 's/^ *Args: *//p' || true)"
    if [ -z "$server" ]; then warn "Claude Code MCP: jarbobo not registered"
    elif [ -f "$server" ]; then ok "Claude Code MCP: $server"
    else warn "Claude Code MCP points at a missing file: $server (rerun: setup.sh install)"; fi
  fi

  local skill="$HOME/.claude/skills/codebase-onboarding"
  if [ -L "$skill" ]; then ok "skill -> $(readlink "$skill")"
  elif [ -e "$skill" ]; then ok "skill at $skill (a copy, not linked)"
  else warn "codebase-onboarding skill not installed"; fi
}

case "$CMD" in
  install) cmd_install ;;
  project) cmd_project ;;
  check)   cmd_check ;;
esac
