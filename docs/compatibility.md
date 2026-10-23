# Compatibility: DSH Desktop Cowork private build

## 2026-10-23 P3 supplement

P3 implementation and SDK transport checks are complete: real elapsed 150/600
seconds, exactly 1000 timer events, concurrent observers, isolated cancellation
and progress. Both caller kinds completed a real Desktop task through a single
SDK long wait (about 165/166 seconds), read full results and released normally.
These are not native Codex/Claude UI capability claims. Production remains
bounded pending native acceptance; see [long-wait.md](long-wait.md).
The installer supports Codex tool_timeout_sec and Claude per-server timeout,
with 960 seconds of client budget and field-only rollback.

## 2026-10-23 addendum — Desktop 0.2.1-rc.2

The installed Host's generated contracts and implementation were inspected for
sequenced inbox projections and the read-only job/list rows stream. The adapter
now reads these on release. A real MCP SDK smoke released two existing claims,
then completed two exclusive-write tasks in the same directory with release
between them. Another live smoke covered busy release refusal, independent
wait cancellation and active-turn steering. The older matrix below is historical.
These results do not establish native caller UI interruption or long-wait support.
See `docs/acceptance.md` for current evidence and boundaries.

This page records only combinations that were actually inspected on the target
machine. Anything not listed here is **not** claimed to work.

## The verified target (this machine, 2026-10-18)

| Fact | Value | Evidence |
|---|---|---|
| OS | Windows 10.0.26200 (x64) | `[Environment]::OSVersion` |
| Desktop shell | DeepSeek Harness Desktop **0.2.0-rc.2**, Electron 44.0.0 | `resources/app.asar/package.json`, `resources/version` |
| Desktop build commit | `04f392c9ddd144fa426da2045178797da6db6c11` | `resources/app.asar/package.json#dshBuildCommit` |
| Harness runtime | `@deepseek-ai/dsh*` **0.2.0-rc.2** | `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json` |
| Host protocol version | **4** | `resources/app.asar/dsh/desktop-runtime.json#release.hostProtocolVersion` |
| Bundled runtime | Node **24.18.1**, pnpm **11.7.0** | `resources/runtime/versions.json` |
| Bundled installer/runtime payload | Node 24.21.0, Python 3.12.14, pnpm 11.7.0 | `resources/runtime/primary-runtime/runtime.json` |
| System Node used by the bridge | **24.21.0** (`C:\Program Files\nodejs\node.exe`) | `node -v` |
| Live Desktop processes | `DeepSeek Harness.exe`, PID 21328/29728/30380 | `Get-Process` |
| Desktop profile | `%USERPROFILE%\.dsh\profiles\desktop` (bundles: `dsh-base`, `dsh-web-app`, `dshmarket`, `dsh-better-sidebar`, `@tt-a1i/archify-dsh`, `dsh-open-design`, `dsh-whale-widget`) | `~/.dsh/profiles/desktop/package.json` |
| Harness home | `%USERPROFILE%\.dsh`, `DSH_PROFILE=desktop`, web origin `http://127.0.0.1:19387` | process environment |

## What the Host actually exposes (read from the installed release)

| Question | Answer | Source |
|---|---|---|
| Is `webServer.getOrigin()` public? | **No.** `WebServer` exposes `host` and `port` getters only. The supported equivalent — used by the official Desktop host itself — is `http://127.0.0.1:${ctx.webServer.port}`. | `@deepseek-ai/dsh-host-webserver/lib/index.js`; `@deepseek-ai/dsh-desktop-host/lib/index.js:337` |
| Is `connection.authenticatedUrl()` public? | **Yes** — `ctx.connection.authenticatedUrl(baseUrl)` appends `?token=<process launch token>`. | `@deepseek-ai/dsh-client-connection/lib/index.js:599-602` |
| Is there a `/connect` API handshake? | **No.** This release has no `/connect` endpoint. | `@deepseek-ai/dsh-client-connection` source and README |
| How does authentication work? | `GET /?token=<launchToken>` → `303` + `Set-Cookie: dsh-auth-<sha256(authority)>…` (HttpOnly, SameSite=Strict, Path=/, authority-bound). Any request without a valid cookie gets `401`; a bad Host/Origin fence gets `403`. | `BrowserAuth.authorizeIndex` / `isAuthenticated` |
| Cookie lifetime | 30 days absolute, `cookieMaxAgeDays` configurable; secret in `%DSH_HOME%/.credentials.yaml` | `dsh-client-connection` README |
| Unary RPC wire | `POST /api/<namespace>/<method>` with `{type:"client-request", rpcId, method, payload:{args}}` → `{type:"server-response", rpcId, result:{ok:true,value}|{ok:false,error}}` | `dsh-client-connection/lib/client.js:1210-1236` |
| Stream wire | WebSocket `/api/remote.mux`; client `open|item|cancel|end`, server `item|end|error` | `@deepseek-ai/dsh-api-gateway/lib/types/stream-protocol.js` |
| Session endpoints | `session/list`, `session/create`, `session/prompt`, `session/page`, `session/follow`, `session/cancel`, `session/projections`, `session/rename`, `session/updateQueue`, `session/modelCatalog`, `session/workspacePathApplications` | generated descriptor table `dsh-api-session-controller/lib/typert.remote-client.js` |
| Does `session/prompt` take a request id? | **Yes** — `requestId` is required, so the Host can de-duplicate a retried dispatch. | generated `SessionPromptRequest` schema |
| Does the profile plugin CLI work while the app runs? | **No.** `dsh plugin --profile desktop …` fails with `EPERM … package.json.lock` because the running app holds the profile lock, and `dsh --profile desktop --dump-config` answers *"profile desktop is managed exclusively by the Electron application"*. | observed on this machine |

## Version matrix

| Desktop / Harness | Protocol family | Adapter | Auth mode | Status |
|---|---|---|---|---|
| 0.2.0-rc.2 (protocol 4) | `dsh-host-0.2` | `desktop-paired` | `browser-session` | **implemented and unit-tested**; connector mount and publication BLOCKED here (see `acceptance.md`) |
| upstream RC6 (`/api/session.*` + `/api/events.mux`) | `dsh-legacy-rc6` | `legacy-rc6` | none | retained for upstream regression only; never selected for a Desktop Host |
| anything else | unknown | — | — | refused with `unsupported_host_version` |

## Local assets inspected

- Extracted `resources/app.asar` (12 967 files) for the installed package sources.
- The same-version external bundle `dsh-open-design` (in the desktop profile as a
  `link:` dependency) as the reference for `dsh.bundle.patch` + `cordis.patch.yml`.
- `resources/runtime/cli/bin/dsh.cmd` — the official Desktop CLI shim.

## What is *not* verified

- Publication of a real `connection.json` from the user's own Desktop run, and the
  full Codex / Claude round trip. Both need the Desktop app to be **fully
  restarted** after the connector is installed, which this session cannot do
  (see `acceptance.md` for the exact one-step recovery).
- Any GPT/Claude model behaviour, any approval round trip, and any second-machine
  installation.

