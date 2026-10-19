# When `dsh_desktop` is missing or unreachable

The bridge is a local stdio MCP server. These are the only supported recovery
paths; do not substitute another connection.

## The `dsh_desktop` tools are not present

The server is not registered in this client. From the installation directory:

```powershell
node dist/setup-desktop.js --caller claude --scope user --dry-run
node dist/setup-desktop.js --caller claude --scope user --apply
```

(For Codex use `--caller codex`.) Then reload the client: Claude Code needs
`/mcp` or a new session to see a newly registered stdio server.

## Tools exist but every call reports `connector_missing`

The Desktop-side publisher has never run. Check with:

```powershell
node dist/doctor-desktop-cli.js --desktop
```

The `connector-registered` layer must be `ok`. If it is `blocked`, install the
bundle through the Desktop's own plugin mechanism and **restart the app** — the
connector activates with the Host, and the CLI cannot operate on the desktop
profile while the app is running.

## `stale_connection` after the app was restarted

Expected: the descriptor is rewritten within five seconds of the new Host
starting. Wait a few seconds and retry `dsh_host_status` once. If it stays stale,
the connector is not loaded — go back to the previous section.

## `unsupported_host_version`

The Desktop release speaks a protocol family this build was not written against.
Stop. Report the reported `protocolFamily` and install a matching build; do not
hand-write requests against an unknown endpoint table.
