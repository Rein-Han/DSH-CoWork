# dsh-desktop-cowork-connector

The Desktop-side half of **DSH Desktop Cowork** (private build).

It publishes the connection facts of the DeepSeek Harness Desktop Host it is
loaded into, so a local MCP bridge can connect to **the same already-running
Desktop Host** instead of discovering a port or guessing a credential.

## Contract

This bundle publishes facts. That is all it does.

- It opens **no** listening port and proxies **no** RPC.
- It starts **no** model and takes over **no** session.
- It never reads `%DSH_HOME%/.credentials.yaml`, the browser Cookie store, the
  account store, process memory, or a debug port.
- The only secret it handles is the launch token the Host itself just minted.

## What it writes

```
%LOCALAPPDATA%\DSHDesktopCowork\connections\<profileKey>\
  identity.json     non-secret, stable per profile (random hostId)
  connection.json   schemaVersion 1; this activation's origin + launch token
```

`connection.json` carries:

`schemaVersion`, `hostId`, `instanceId`, `profileKind`, `profileFingerprint`,
`desktopVersion`, `harnessVersion`, `origin`, `hostPid`, `hostStartedAt`,
`publishedAt`, `authMode`, `protocolFamily`, `launchToken`.

- `origin` is `http://127.0.0.1:${webServer.port}` — the same expression the
  official Desktop host uses, because this release exposes `host`/`port` getters
  rather than `getOrigin()`.
- `launchToken` comes from `connection.authenticatedUrl(origin + '/')` and is
  parsed out in-process. The authenticated URL itself is never stored or logged.
- `instanceId` is regenerated on every activation; `hostId` survives restarts.
- `publishedAt` is refreshed every 5 s; the bridge treats 30 s of silence as
  stale.
- `hostStartedAt` is the Host process's own creation instant
  (`Date.now() - process.uptime()`), so the bridge can detect PID reuse.

## Security model

1. The private directory is created, then restricted with the operating system's
   own ACL machinery (`icacls /inheritance:r` plus explicit grants for this
   user's SID, `SYSTEM`, and `Administrators`).
2. The applied policy is re-read and judged. Any inherited entry, `Everyone`,
   `Users`, `Authenticated Users`, or unexpected principal makes the plugin
   **refuse to publish**. `chmod` is never treated as an ACL.
3. Only then is anything written; the descriptor is replaced atomically through a
   same-directory temporary file, and the written file is verified again.
4. On dispose the descriptor is removed only while it still names this
   activation's `instanceId`.

The launch token grants **Host-owner API identity**, not a project-scoped
credential. The private file protects the secret; the MCP tool surface and
workspace claims are cooperation rules, not a second permission boundary.

Deleting `connection.json` does not revoke cookies or tokens the Host already
issued. See `docs/rollback.md` in the bridge package for the real revoke steps.

## Load

It is an official DSH bundle: `package.json#dsh.bundle.patch` points at
`cordis.patch.yml`, which inserts one entry with `inject = ['webServer', 'connection']`.

Install it into the Desktop profile with the Desktop app **fully closed** (the
profile is locked while the app runs):

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add .\dsh-desktop-cowork-connector-1.0.0.tgz
```

## Requirements

- Windows (NTFS ACLs are part of the publish precondition).
- DeepSeek Harness Desktop `0.2.0-rc.2` / host protocol 4 for this release.
- Peer dependency: `@deepseek-ai/cordis` ^4.0.4, supplied by the Host runtime —
  this package bundles no copy of the Host, the agent, Cordis, or the credential
  service.
