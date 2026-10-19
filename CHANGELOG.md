# Changelog

This file records user-visible changes to Codex-DSH-Orchestrator. The project
is distributed as source code; `package.json` remains private and this file
does not announce an npm publication.

## Unreleased

## DSH-CoWork 0.1.0-alpha.5 — DSH Desktop build (2026-10-19)

First release of the DSH Desktop rewrite. Everything below this section is the
upstream Codex-DSH-Orchestrator history.

- New `desktop-paired` mode: a DSH Desktop plugin (`dsh-desktop-cowork-connector`
  1.0.1) publishes the running Host's connection facts to a user-private file;
  the `dsh_desktop` MCP server authenticates with them. Verified live against
  DeepSeek Harness Desktop 0.2.1-rc.2.
- New `codex-dsh-desktop` / `claude-dsh-desktop` skills and the
  `setup-desktop` / `doctor:desktop` / `verify-desktop` commands.
- Windows installer (Inno Setup) bundling Node.js; installs the plugin and
  registers both callers, with a matching uninstaller.
- Desktop mode inherits model, effort and preset from DSH Desktop; routing
  inputs are refused before any session is created.
- The MCP server starts even when DSH Desktop is closed and reports a stable
  `errorCode` from `dsh_host_status`.
- `setup-desktop --apply` refuses to register a placeholder connection file.
- Fixed Windows checks that blocked publication: absolute System32 tool paths
  (Git ships a GNU `whoami`), `icacls` reporting `DOMAIN\name` rather than the
  SID, inherited ACEs on the connection file, and PowerShell 5.1 lacking
  `Get-Date -AsUTC`.
- Upstream docs moved to `docs/legacy/`.

## 0.1.0-alpha.5 — source release

- Added a bounded visual-routing policy: non-visual routine and difficult work
  keeps the existing Flash/Pro distinction; low-complexity visual work uses
  the official native Flash Vision route.
- High-complexity visual work now requires an explicit choice between official
  Flash Vision and ModLens Pro. ModLens Flash remains a one-time fallback only
  after bounded timeout, unreachable-Host, or HTTP 5xx failures; other failure
  classes remain fail-closed.
- Added non-sensitive fallback status reporting and regression coverage for
  prompt-failure handling and legacy explicit model-profile compatibility.
- Added macOS Node.js 22/24 CI coverage and normalized the macOS temporary
  directory fixture so the test suite respects the existing symlink-safe
  installation policy.

## 0.1.0-alpha.4 — portability documentation candidate

- Documented fresh-clone/worktree and stable-directory requirements.
- Made Codex setup install the shipped repository-scoped skill by default, with `--no-skill`, `--skill-path`, and explicit `--replace-skill` conflict handling.
- Reorganized human Quick Start and the compact AI-agent installation contract around the real MCP-plus-skill setup flow.
- Documented the tested Node.js 22/24 matrix and DSH Desktop/bridge-home boundaries.
- Kept the package private; this source candidate does not announce an npm publication.

## 0.1.0-alpha.2 — source snapshot

- Established Codex-DSH-Orchestrator as the public project identity.
- Added a project overview describing ownership, component boundaries,
  supported callers, and the DSH Web Host safety boundary.
- Clarified that the shared bridge runtime is an independently maintained
  derivative of dsh-Agentlink.
- Retained the upstream MIT license, copyright attribution, runtime package
  names, CLI names, and MCP identifiers for legal and compatibility reasons.
- Added maintainer-facing source-release checks and aligned the public README,
  architecture documentation, and contribution guidance.
- No core communication protocol or bridge behavior changes are included in
  this documentation-focused snapshot.
