#!/usr/bin/env bash
# Rebuild better-sqlite3 from source against a specific Node.js binary.
#
# Run this after any `npm install` or Node.js upgrade if the MCP server fails
# with a NODE_MODULE_VERSION mismatch error.
#
# Usage:
#   npm run rebuild:native            # auto-detects node@24 on macOS
#   NODE24=/path/to/node npm run rebuild:native   # explicit node binary

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODULE_DIR="$PACKAGE_DIR/node_modules/better-sqlite3"

# ---------------------------------------------------------------------------
# Locate the node binary to build against.
#
# Preference order:
#   1. NODE24 env var (explicit override, any version)
#   2. Homebrew node@24 arm64 (/opt/homebrew — Apple Silicon)
#   3. Homebrew node@24 x86  (/usr/local/opt  — Intel Mac)
#   4. System node (fallback; ABI may not match the MCP server pin)
# ---------------------------------------------------------------------------
if [[ -n "${NODE24:-}" ]]; then
  NODE_BIN="$NODE24"
elif [[ -x "/opt/homebrew/opt/node@24/bin/node" ]]; then
  NODE_BIN="/opt/homebrew/opt/node@24/bin/node"
elif [[ -x "/usr/local/opt/node@24/bin/node" ]]; then
  NODE_BIN="/usr/local/opt/node@24/bin/node"
else
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  if [[ -z "$NODE_BIN" ]]; then
    echo "error: no node binary found in PATH" >&2
    exit 1
  fi
  echo "warning: node@24 not found; building for system node $("$NODE_BIN" --version)" >&2
  echo "         The MCP server is pinned to node@24; ABI may not match." >&2
  echo "         Install with: brew install node@24" >&2
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "error: node binary not found or not executable: $NODE_BIN" >&2
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" --version)"
MODULE_VERSION="$("$NODE_BIN" -e 'process.stdout.write(String(process.versions.modules))')"
NODE_PREFIX="$("$NODE_BIN" -e 'process.stdout.write(process.execPath.replace(/[/\\]bin[/\\]node$/, ""))')"

echo "Rebuilding better-sqlite3..."
echo "  node:           $NODE_BIN ($NODE_VERSION)"
echo "  MODULE_VERSION: $MODULE_VERSION"
echo "  nodedir:        $NODE_PREFIX"

if [[ ! -d "$MODULE_DIR" ]]; then
  echo "error: better-sqlite3 not found at $MODULE_DIR" >&2
  echo "       Run: npm install" >&2
  exit 1
fi

# Use the node-gyp bundled with the target node's npm. This is always present
# when node@24 was installed via Homebrew and avoids network fetches for headers.
BUNDLED_NODE_GYP="$NODE_PREFIX/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"

cd "$MODULE_DIR"

run_node_gyp() {
  local log_file status binary_mtime_ms
  log_file="$(mktemp)"

  set +e
  "$@" 2>&1 | tee "$log_file"
  status=${PIPESTATUS[0]}
  set -e

  if [[ "$status" -eq 0 ]]; then
    rm -f "$log_file"
    return 0
  fi

  # node-gyp 12 can fail after a successful build while cleaning up its
  # temporary build/node_gyp_bins helper directory. Do not hide real build
  # failures: only continue when that exact cleanup error happened and the
  # native binary was relinked during this run. The normal verification step
  # below still proves the target Node can load the rebuilt module.
  if grep -q "build/node_gyp_bins" "$log_file" && [[ -f build/Release/better_sqlite3.node ]]; then
    binary_mtime_ms="$($NODE_BIN -e "const fs = require('fs'); process.stdout.write(String(fs.statSync('build/Release/better_sqlite3.node').mtimeMs));")"
    if "$NODE_BIN" -e "process.exit(Number('$binary_mtime_ms') >= Number('$BUILD_START_MS') ? 0 : 1);"; then
      echo "warning: node-gyp failed during node_gyp_bins cleanup after producing the native binary; continuing to verification" >&2
      rm -f "$log_file"
      return 0
    fi
  fi

  rm -f "$log_file"
  return "$status"
}

# node-gyp 12 may lstat this helper directory during cleanup even when it did
# not create it. Ensure it exists before starting the rebuild.
mkdir -p build/node_gyp_bins
BUILD_START_MS="$($NODE_BIN -e 'process.stdout.write(String(Date.now()))')"

if [[ -f "$BUNDLED_NODE_GYP" ]]; then
  run_node_gyp "$NODE_BIN" "$BUNDLED_NODE_GYP" rebuild --release "--nodedir=$NODE_PREFIX"
else
  # Fallback: use node-gyp from PATH (may need `npm install -g node-gyp`).
  echo "warning: bundled node-gyp not found at $BUNDLED_NODE_GYP" >&2
  echo "         Falling back to node-gyp from PATH." >&2
  NODE_GYP="$(command -v node-gyp 2>/dev/null || true)"
  if [[ -z "$NODE_GYP" ]]; then
    echo "error: node-gyp not found. Install with: npm install -g node-gyp" >&2
    exit 1
  fi
  run_node_gyp "$NODE_GYP" rebuild --release "--nodedir=$NODE_PREFIX"
fi

# ---------------------------------------------------------------------------
# Verify the built binary actually loads with the target node.
# ---------------------------------------------------------------------------
echo "Verifying..."
"$NODE_BIN" -e "
const Database = require('$MODULE_DIR');
const db = new Database(':memory:');
const row = db.prepare('SELECT 42 AS n').get();
if (row.n !== 42) throw new Error('unexpected result: ' + JSON.stringify(row));
db.close();
console.log('  ok: NODE_MODULE_VERSION $MODULE_VERSION');
"

echo "Done."
