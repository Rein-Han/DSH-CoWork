# Rollback and credential lifecycle

## What this build installs

| Artifact | Location | Removable by |
|---|---|---|
| Connector bundle registration | `%USERPROFILE%\.dsh\profiles\desktop\package.json` + `node_modules` | `dsh plugin --profile desktop remove dsh-desktop-cowork-connector` (app closed) |
| Connection descriptor | `%LOCALAPPDATA%\DSHDesktopCowork\connections\<profileKey>\connection.json` | Connector on dispose, or delete by hand |
| Stable identity | same directory, `identity.json` | Delete by hand; it is not a credential |
| MCP entries | `~/.codex/config.toml`, `~/.claude.json` | `setup-desktop --uninstall --apply` |
| Skills | `~/.agents/skills/codex-dsh-desktop`, `~/.claude/skills/claude-dsh-desktop` | same command |
| Bridge ledger + task records | `%LOCALAPPDATA%\DSHDesktopCowork\bridge` | kept on purpose |

## Uninstall

```powershell
node dist\uninstall-desktop.js --dry-run
node dist\uninstall-desktop.js --apply
```

Then, with the Desktop **fully closed**:

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop remove dsh-desktop-cowork-connector
```

What is preserved:

- every DSH Desktop session and its transcript (owned by DSH, not the bridge);
- your project files;
- `%LOCALAPPDATA%\DSHDesktopCowork\bridge` (task ledger) — delete only if you
  also want to lose task history;
- any *other* MCP server or skill in your configurations;
- any file you edited after installation. The installer only rewrites its own
  key/table; if you changed that entry yourself, the uninstaller leaves your
  version alone and says so.

## Restoring a configuration file

Every write goes through `atomicInstallText`, which first writes a backup next to
the target and returns its path in the command output. Restore by copying the
backup over the target with the client closed. Backups are never overwritten by a
later run.

## Credential lifecycle (read this before assuming "revoked")

Deleting `connection.json` **does not revoke** the browser-session cookie or the
process launch token that the Host already issued:

- the launch token lives for the Host process's lifetime;
- cookies are signed with a secret in `%DSH_HOME%/.credentials.yaml` and stay
  valid for their absolute lifetime (30 days by default);
- the bridge keeps only its own cookie in memory and drops it on `disconnect()`.

For a genuine revoke:

1. close every bridge process (closing the Codex/Claude session ends the MCP
   server and its socket);
2. restart DeepSeek Harness Desktop — that mints a new process token and the
   connector republishes;
3. if you want *every* browser session invalidated, delete the
   `client-connection/browser-session` record from `%DSH_HOME%/.credentials.yaml`
   and restart the Desktop. Every browser cookie then stops verifying.

The launch token grants **Host-owner API identity**, not a project-scoped
credential. The private file, the tool surface, and workspace claims are three
different things: only the first protects the secret.

## If the connector refuses to publish

It refuses rather than degrading. Check the directory's DACL
(`icacls <dir>`): a private directory has no `(I)` entries and grants only your
account, `NT AUTHORITY\SYSTEM`, and `BUILTIN\Administrators`. If you cannot fix
it, uninstall the bundle — no descriptor exists, so nothing is exposed.

## Removing everything by hand

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\DSHDesktopCowork"
```

This removes the descriptor, the identity and the task ledger. It does not remove
the MCP entries or skills (use the uninstaller), and it does not touch your DSH
sessions.

