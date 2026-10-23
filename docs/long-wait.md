# Long wait: implementation and native-client acceptance

The production bridge supports `DSH_WAIT_PROFILE=bounded|long`. The default
remains bounded. Both profiles default to 30 seconds; long permits an explicit
`until=terminal,timeoutSec=900`. Change waits remain limited to 30 seconds.
Invalid or excessive values are rejected, never silently clamped.

`dsh_host_status.observation.policyVersion=2` identifies the P3 implementation.
`clientLongWaitVerified=false` is deliberate: a server cannot infer the current
client UI's concurrency, interruptions, background collection or version from
its environment. Record those independently before enabling a production long
profile. `workspaceRelease.policyVersion=2` identifies the P2 release fix.

## Timeout ownership

`setup-desktop --caller codex|claude --scope user --wait-profile long --replace
--apply` raises only this service's client limit to at least **960 seconds**:
Codex `tool_timeout_sec=960`; Claude server entry `timeout=960000`. A larger
user value survives. The 60-second margin over the bridge's 900-second limit
allows transport and cleanup; it does not increase Host RPC deadlines.
The specification's 930 seconds was a candidate, not a required constant.

Do not put `MCP_TOOL_TIMEOUT` inside the server's `env`: that configures the
child, not the calling Claude process. Do not change global timeout or approval
settings. See [Codex MCP settings](https://learn.chatgpt.com/docs/extend/mcp)
and [Claude server timeouts](https://code.claude.com/docs/en/mcp#managing-your-servers).
Claude's documented background behavior still needs testing in the installed
version and entry point; CLI/headless results do not establish Desktop behavior.

For rollback, preserve the installer backup path and preview:

```powershell
node dist/rollback-wait-profile.js --caller codex --backup '<Codex backup>'
node dist/rollback-wait-profile.js --caller claude --backup '<Claude backup>'
```

Add `--apply` to restore only the wait-profile/timeout fields still matching
this installer's long settings. Add `--project <directory>` for project configs.
Later user edits and other services survive. If long was installed into an entry
that did not previously exist, use the ordinary uninstall for that new entry;
field rollback requires both entries. Never restore an entire config backup
over intervening changes. Setting `--wait-profile bounded` immediately limits
bridge waits to 30 seconds but intentionally does not lower a custom client limit.

## Protocol and resource behavior

- A single monotonic deadline includes synchronization and all ordinary events.
- Standard MCP progress is sent only with a request `progressToken`, at most
  once per 30 seconds, without a body or fabricated completion percentage.
  Its number is elapsed seconds. Progress cannot extend the client's hard limit.
- Cancellation stops that observer and its progress/timers. It never invokes
  DSH cancellation. Task reconciliation/pumps and other readers remain alive.
  Caller-scoped model/history/list reads receive cancellation signals; shared
  task reconciliation retains its own bounded Host request lifetime.
- Ordinary events use local projection state. Authority is refreshed initially
  and for candidate completion; it is not fetched for every ordinary event.
- Ledger records remain append-only under the existing interprocess file lock.
  The in-memory index reads only new bytes, checks file identity and the append
  boundary, and rebuilds on replacement, shrink or same-size metadata changes.
  A partial trailing record fails closed. This is not protection against an
  external program rewriting arbitrary older bytes while bypassing the lock.
- One periodic ledger check per task, no faster than once per second, serves all
  local observers. Each registration also checks for a missed wakeup. Last
  observer removal clears its poller; durable collection is independent.

## Reproducible tests

`node scripts/check-p3-transport.mjs` runs actual 150-second and 600-second
stdio MCP calls, 1000 ordinary events, four concurrent long observers, one
observer cancellation, status during waiting and progress/no-progress variants.
It uses the standalone timer-only `scripts/p3-fixture.mjs` and production wait
policy. No model or DSH is contacted. This is **SDK evidence**, not native UI
acceptance. Unit tests cover a virtual ten-minute sequence and a real ledger
resource matrix of 0/100/1000 events by 1/4 waiters.

`node scripts/live-p3-smoke.mjs` explicitly creates two small real DSH tasks in
fresh isolated directories, one SDK connection for each caller kind, with a
single long wait, full result read and normal release. It spends DSH usage.
Its receipt files preserve the exact task/bridge-home if a run fails; do not
blindly rerun an ambiguous prompt. Production data and claims are separate.

## Native acceptance setup

`node scripts/setup-p3-acceptance.mjs` previews an independent, timer-only
`dsh_wait_acceptance` entry for both clients. `--apply` installs it with backups;
reload MCP afterwards. Its tools are named `p3_start`, `p3_wait`, `p3_status`,
`p3_metrics`; they have no DSH credentials or DSH write tools. Production
`dsh_desktop` stays bounded while client capabilities are under test.

For **each exact version and entry point**, record:

1. `p3_start(seconds=150)`, then exactly one `p3_wait(jobId,timeoutSec=900)`;
   result must return to the originating conversation after at least 150 seconds.
2. Repeat with `seconds=600,ordinaryEvents=1000`; no repeated wait or automatic
   model polling. Keep any native background task handle and collect its result.
3. During a separate wait, send an ordinary user message. Record whether the
   client can receive, respond, queue it, or cancel observation; do not assume.
4. Stop an observation using the caller UI, then query its job once. Work must
   remain running or completed; reattach and collect without creating new work.
5. During A's wait, query a separate job B once. Record concurrency behavior.
6. If native backgrounding occurs, record its handle and eventual notification
   and prove result ownership. If unsupported, mark it unsupported, not PASS.
7. Run a tiny real DSH task from the native client: inherited model/permissions,
   completion, full result, release, then another write in the same test directory.

Choose long only for the verified scenario. Unsupported native parallelism means
use bounded waits for multi-task supervision. A hard long-call timeout means
stay bounded for that client. Client/version/entry/config changes require review.
After acceptance, remove the temporary entry with:

```powershell
node scripts/setup-p3-acceptance.mjs --remove --apply
```

Removal refuses a modified acceptance entry rather than deleting user changes.
