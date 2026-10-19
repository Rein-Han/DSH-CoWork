# Install: connecting Codex and Claude Code to your existing DSH Desktop

Everything here runs on the same Windows account that owns the Desktop install.
No administrator rights, no npm publish, no new Host.

## 0. What gets installed

| Piece | Where | Why |
|---|---|---|
| `dsh-desktop-cowork-connector` bundle | Desktop profile plugin list | Publishes the running Host's origin + launch token into a private file |
| Bridge MCP server (`dsh_desktop`) | Codex `config.toml`, Claude `~/.claude.json` | The stdio process both clients talk to |
| `codex-dsh-desktop` / `claude-dsh-desktop` skill | `~/.agents/skills/…`, `~/.claude/skills/…` | Tells each main agent how to delegate and accept |

## 1. Build the artifacts

```powershell
cd "%USERPROFILE%\Documents\Agent works\Co-working\dsh-desktop-cowork"
npm install --ignore-scripts
npm run build
cd packages\desktop-connector; npm pack
```

## 2. Install the connector into the Desktop profile

The running Desktop holds an exclusive lock on its profile, so the Desktop app
must be **fully quit** first (tray → Quit; confirm no `DeepSeek Harness.exe`
remains):

```powershell
Get-Process "DeepSeek Harness" -ErrorAction SilentlyContinue
```

Then, with the app closed:

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "%USERPROFILE%\Documents\Agent works\Co-working\dsh-desktop-cowork\packages\desktop-connector\dsh-desktop-cowork-connector-1.0.0.tgz"
```

Start **DeepSeek Harness Desktop** again. The connector activates with the Host
and writes, within five seconds:

```
%LOCALAPPDATA%\DSHDesktopCowork\connections\<profileKey>\connection.json
```

It is never written before the ACL step succeeds. If the file does not appear,
run the doctor (step 4) — do not hand-create it.

> The launch token in `connection.json` grants **Host-owner API identity**. It is
> not scoped to a project. The private file and its ACL are what keep it away
> from other accounts; the tool surface and workspace claims are cooperation
> rules, not a second permission boundary.

## 3. Register the bridge with your callers

```powershell
node dist\setup-desktop.js --caller both --scope user --dry-run
node dist\setup-desktop.js --caller both --scope user --apply
```

`--caller codex|claude|both`, `--scope user|project`, `--project <dir>`.
Every changed file is backed up first; a second run changes nothing; an existing
*different* `dsh_desktop` entry is reported and only replaced with `--replace`.

Reload your clients so they pick up the new MCP server:

- Codex: start a new session (MCP servers are read at session start).
- Claude Code: `/mcp` or a new session.

## 4. Diagnose

```powershell
node dist\doctor-desktop-cli.js --desktop
node dist\doctor-desktop-cli.js --desktop --json
```

Layer order: `desktop-runtime` → `connector-registered` → `published-connection`
→ `legacy-entries`. A `blocked` layer is the one to fix first.

## 5. Verify one real round trip

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\Documents\cowork-acceptance" | Out-Null
node dist\verify-desktop.js --project "$env:USERPROFILE\Documents\cowork-acceptance"
```

This creates one real DSH session in that directory, sends one harmless prompt,
follows it to `turn/end`, and prints the session id plus the final assistant
text. Compare the session id with the one now visible in DSH Desktop. The
session is left in place deliberately — it is the evidence.

## 6. Use it

In Codex or Claude Code, ask: *"hand this to DSH"*. The skill then uses
`dsh_host_status` → `dsh_delegate` → `dsh_wait` → acceptance → `dsh_release_workspace`.

## 7. Uninstall

```powershell
node dist\uninstall-desktop.js --dry-run
node dist\uninstall-desktop.js --apply
```

(`node dist\setup-desktop.js --uninstall …` is the same code path.)

then remove the bundle with the Desktop app closed:

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop remove dsh-desktop-cowork-connector
```

Your DSH sessions, project files, task ledger
(`%LOCALAPPDATA%\DSHDesktopCowork\bridge`) and the published descriptor are kept
unless you delete them yourself. See `rollback.md`.


