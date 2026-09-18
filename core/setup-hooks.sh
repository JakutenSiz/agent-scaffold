#!/bin/sh
# ============================================================
# agent-scaffold git hook installer (POSIX version) -- see setup-hooks.bat
# for the Windows cmd.exe equivalent. Git does not run in-repo hooks
# automatically for security reasons; this script must be run once per
# clone. Idempotent -- safe to re-run at any time.
# The gate itself lives at: .githooks/pre-push
# ============================================================
ROOT=$(cd "$(dirname "$0")" && pwd)

git -C "$ROOT" config core.hooksPath "$ROOT/.githooks" && echo "[setup-hooks] root: configured"

if [ -f "$ROOT/agent-scaffold.config.json" ] && [ -f "$ROOT/scripts/list-configured-repos.mjs" ]; then
  repo_paths=$(node "$ROOT/scripts/list-configured-repos.mjs" "$ROOT")
  old_ifs=$IFS
  IFS='
'
  for r in $repo_paths; do
    [ -n "$r" ] || continue
    if [ -e "$ROOT/$r/.git" ]; then
      git -C "$ROOT/$r" config core.hooksPath "$ROOT/.githooks" && echo "[setup-hooks] $r: configured"
    fi
  done
  IFS=$old_ifs
fi

if ! command -v gitleaks >/dev/null 2>&1 \
   && [ ! -x "$LOCALAPPDATA/Microsoft/WinGet/Packages/Gitleaks.Gitleaks_Microsoft.Winget.Source_8wekyb3d8bbwe/gitleaks.exe" ]; then
  echo "[setup-hooks] WARNING: gitleaks is not installed -- the secret scan will not run."
  echo "[setup-hooks] Install: winget install Gitleaks.Gitleaks (or: brew install gitleaks)"
fi

echo "[setup-hooks] pre-push gate configured for the root repo and every configured sub-repo."
