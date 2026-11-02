#!/bin/bash
set -eu
cd "$(dirname "$0")"
APP='/Applications/DeepSeek Harness.app'
NODE="$APP/Contents/Resources/runtime/bin/node"
if [[ "$(uname -s)" != Darwin ]]; then echo 'This installer supports macOS only.'; exit 1; fi
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
export DSH_DESKTOP_NODE_EXECUTABLE="$APP/Contents/MacOS/DeepSeek Harness"
if [[ ! -x "$NODE" ]] || ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
  NODE="$(command -v node || true)"
fi
if [[ -z "$NODE" ]] || ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then echo 'Node.js 20 or newer is required.'; exit 1; fi
if [[ "${1:-}" == '--check' ]]; then exec "$NODE" lib/environment.js; fi
if [[ $# -ne 0 ]]; then echo 'Usage: Install.command [--check]'; exit 1; fi
exec "$NODE" server.js
