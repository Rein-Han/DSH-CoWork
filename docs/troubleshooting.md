# Troubleshooting by error code

First stop is always:

```powershell
node dist\doctor-desktop-cli.js --desktop --json
```

It reports four layers — `desktop-runtime`, `connector-registered`,
`published-connection`, `legacy-entries` — and never prints a token.

## `desktop_not_running`

The PID named by the descriptor is gone, or nothing listens on its origin.

- Start **DeepSeek Harness Desktop** and retry `dsh_host_status` once.
- The bridge never starts a Host for you.
- If the Desktop is running but this persists, the descriptor is stale; see the
  restart note in `install-windows.md`.

## `connector_missing`

- No `connection.json` under `%LOCALAPPDATA%\DSHDesktopCowork\connections\<profileKey>\`.
- The bundle is not installed, or has not activated since installation. Restart
  the app; the connector publishes on Host start.
- If `doctor --desktop` shows `connector-registered: blocked`, install the bundle
  with the app **closed** (the profile is locked while it runs).

## `connection_file_insecure`

The bridge refuses to use the descriptor. Causes:

- the directory still inherits rights (`(I)` entries) or grants `Everyone`,
  `Users`, `Authenticated Users`, `INTERACTIVE`, or an unexpected principal;
- the path is a junction/symlink, or resolves somewhere else;
- the process cannot change the DACL (for example a low-integrity sandbox token).

The fix belongs to the publisher: it must run as the normal user, own its
directory, and apply the ACL before writing anything. **Never** work around this
by copying the token to another file, relaxing the check, or `icacls /grant
Everyone`.

## `stale_connection`

- `publishedAt` is older than 30 s, or dated in the future.
- After a Desktop restart the descriptor is rewritten within ~5 s: wait and read
  once more.
- Repeatedly stale means the connector is not running (see `connector_missing`)
  or the machine clock jumped.

## `host_identity_mismatch`

The descriptor's PID, creation time, or owning listener no longer matches.
Another Host took the port. Do not send the launch token; restart the Desktop so
a fresh descriptor is published, then retry.

## `auth_required` / `auth_rejected`

- `auth_required`: this generation's cookie was rejected — the Host restarted or
  the cookie secret was replaced. The adapter discards the generation and
  re-reads the descriptor once.
- `auth_rejected`: the launch token was refused or the exchange returned no
  cookie. Tokens are per process; a stale file cannot be reused. Restart the
  Desktop and let the connector republish.
- There is no anonymous fallback and no `Authorization:` path in this release.

## `unsupported_host_version` / `protocol_mismatch`

The Desktop speaks a protocol family this build does not implement, or a
response did not match the documented envelope. Record the reported
`protocolFamily` and stop. Install a build written against that release — do not
improvise requests against an unknown endpoint table.

## `capability_unavailable`

Something the caller asked for is not provided by this adapter. In paired mode
that is normally `selectModel` (change the model in **Desktop → Settings →
Models**) or approval relay (answer in the Desktop UI). Nothing was sent to the
Host.

## Approval and question states

`awaiting_approval` / `awaiting_input` mean a human must act in DSH Desktop. The
private build registers no approval tool, by design. If the protocol does not
expose the interaction body, the status says *unknown* — it is never invented.

## Directory conflicts

`workspace_conflict` means another task claims an overlapping directory (parents
and children count). Use a disjoint directory or a separate worktree, or finish
and release the other task with `dsh_release_workspace`. Releasing is refused
while the session is running, queued, awaiting approval, or awaiting input.

## Legacy entries

`doctor --desktop` warns when `dsh_agentlink`/`dsh_collab` are still configured.
Both skills are told to use `dsh_desktop` only, so a stale entry is harmless but
misleading; remove it from `~/.codex/config.toml` or `~/.claude.json` by hand —
this project never deletes another server's configuration.

## The `dsh_desktop` tools do not appear at all

The MCP server is not registered in that client, or the client was not reloaded.
Re-run `setup-desktop --dry-run` for that caller and reload the client
(`/mcp` in Claude Code; a new session in Codex).
