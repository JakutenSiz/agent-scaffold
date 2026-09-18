@echo off
REM ============================================================
REM agent-scaffold git hook installer -- enables the pre-push gate.
REM Git does not run in-repo hooks automatically for security reasons;
REM this script must be run once per clone (idempotent, safe to re-run).
REM The gate itself lives at: .githooks\pre-push
REM ============================================================
SET ROOT=%~dp0

git -C "%ROOT%." config core.hooksPath "%ROOT%.githooks"

if exist "%ROOT%agent-scaffold.config.json" if exist "%ROOT%scripts\list-configured-repos.mjs" (
  for /f "usebackq delims=" %%R in (`node "%ROOT%scripts\list-configured-repos.mjs" "%ROOT%."`) do (
    if exist "%ROOT%%%R\.git" (
      git -C "%ROOT%%%R" config core.hooksPath "%ROOT%.githooks"
    )
  )
)

where gitleaks >nul 2>nul
if not errorlevel 1 goto gitleaks_ok
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gitleaks.Gitleaks_Microsoft.Winget.Source_8wekyb3d8bbwe\gitleaks.exe" goto gitleaks_ok
echo [setup-hooks] WARNING: gitleaks is not installed -- the secret scan will not run.
echo [setup-hooks] Install: winget install Gitleaks.Gitleaks
:gitleaks_ok

echo [setup-hooks] pre-push gate configured for the root repo and every configured sub-repo.
