# Acceptance matrix — DSH Desktop Cowork private build

## 2026-10-24 Desktop project workspace resolution

- Strict product build PASS. Standard `npm run check` reports **317 PASS / 6 FAIL**;
  all six failures are the known Windows `EPERM symlink` privilege cases. The full
  portable regression excluding exactly those six cases reports **317 PASS / 0 FAIL**.
  Test-source emission retains the pre-existing typing diagnostics; this is not a
  clean test-tsc claim. New adapter, Bridge, MCP and five-skill contract tests pass.
- Existing Co-working reuse PASS: Kimi Code `dsh_cef3af9f6579` used a legacy test
  subdirectory as requested cwd but returned `created=false`, `resolution=exact`,
  with session cwd and claim both at the Co-working root. Desktop shows the session
  under Co-working, not under the subdirectory project.
- Existing Buffer Calculator reuse PASS: Codex `dsh_dfa07a9d691b` returned
  `created=false`, `resolution=exact` at the existing project root; Desktop shows
  the session under Buffer Calculator.
- New-project creation and cross-caller reuse PASS: Codex `dsh_166ee5cae603`
  created exactly one new root (`created=true`, `resolution=created`). Claude Code
  `dsh_87374f2016cb`, ZCode `dsh_cd2d4d738558`, Kimi Code `dsh_c212c978907d`, and
  Kimi Work `dsh_84e930d68ba3` all reused workspaceId
  `2dc52a88-d0dd-4599-9837-535ac4824426` with `created=false` and `resolution=exact`.
  All five sessions used the project root as actual cwd/claim; no `child` project
  was created. Desktop's expanded project row shows all five under the same root.
- Every real marker result was read in full and released with `desktop-live`
  inbox/jobs evidence (`queueKnownEmpty=true`, `jobsKnownIdle=true`). The acceptance
  bridge homes contain no remaining claim files. Evidence:
  `analysis/project-grouping-20261024/` (receipts and per-project summaries).
- These are real Host plus SDK and Desktop-sidebar observations, not native
  Codex/Claude/ZCode/Kimi UI acceptance. Each installed caller must reload its MCP
  schema and updated skill before native use; Connector was not reinstalled.

## 2026-10-24 ZCode / Kimi local integration

- Product strict TypeScript build PASS; portable regression **310 PASS / 0 FAIL**.
  Six existing Windows symlink privilege cases excluded; Node's skipped=0 does
  not count cases excluded before registration. Test-source emission still
  reports the pre-existing typing diagnostics; this is not a clean test tsc claim.
- Five caller skills pass quick_validate. New tests cover settings preservation,
  bounded enforcement, project/user paths, install races/refusal, Work export,
  target/cursor ownership, canceled, interaction/offline and observation budgets.
- Real Desktop SDK: zcode dsh_0a5c7a90ff11, kimi-code dsh_9aa5505bf454,
  kimi-work dsh_76030f87bba2: complete marker results and desktop-live normal
  release; queueKnownEmpty/jobsKnownIdle were obtained from the live Host.
- Real client UI loading, approval, interruption and background behavior remain
  pending. Work also requires its account's user MCP settings capability.
- Same-directory real write lifecycle PASS: ZCode dsh_42d8cae6b16e writes
  phase1.txt, file verified before desktop-live release; Kimi Code then claims
  that exact cwd, writes phase2.txt and releases (dsh_9ee65a787385). Both used
  one shared isolated bridge home. No claims remain in that acceptance home.
- Evidence: parent analysis/zcode-kimi-integration-2026-10-24, including generated
  project configs, task receipts, full logs and the skill-only Work export.

## 2026-10-23 P3 supplement

- Strict build PASS; portable full regression **293 PASS / 0 FAIL**, excluding
  the same six Windows symlink cases. Eight P3 tests add incremental ledger,
  progress, cancellation, configuration rollback and resource matrix coverage.
- Final real elapsed SDK fixture: 150 seconds and 600013ms; exactly 1000
  ordinary events; each observer uses one terminal call; all observers/timers
  settle. Initial interval-drift fixture emitted only 991 events and is superseded.
- Real Host, SDK clients: dsh_47fcd7283933 (codex), dsh_2f80b76cfbf3
  (claude-code), both complete result/release PASS in fresh isolated bridge homes.
- Evidence: parent `analysis/supervision-fix-v2/2026-10-23-p3`; native UI gates
  remain pending. [long-wait.md](long-wait.md) documents the independent timer MCP,
  exact client acceptance, configuration and rollback. Keep production bounded
  until the applicable client scenario passes; P2 unverified cases remain below.

## 2026-10-23 P2 supplement

- Product build PASS; portable regression 285 PASS, 0 FAIL, with the same six
  Windows symlink-permission cases excluded. Old test TypeScript diagnostics
  remain; the strict product build is checked separately.
- Desktop 0.2.1-rc.2 live MCP SDK: two old claims released with actual inbox/jobs
  evidence; two consecutive writes in one directory completed and released;
  canceling one observer preserved the task and second observer; active steer
  returned STEER_OK; busy release was refused. No claim/ledger was deleted by hand.
- Fakes default queue/jobs to unknown. Desktop release tests use the actual
  adapter's wire parser. Real Host verification is recorded separately from mocks.
- Evidence in the parent workspace: `analysis/supervision-fix-v2/2026-10-23`;
  detailed scope: `DSH-CoWork-P2-Delivery-2026-10-23.md`.
- P2 native interaction/descendant and explicit task-cancel live scenarios still
  need evidence. P3 native long waits/background/UI interruption remain unverified.
  Keep bounded=30. Existing clients need reload for this build and updated skills.

The original matrix below records the earlier installation environment, not the
current live-verification status.

Environment: Windows 10.0.26200 x64 · DeepSeek Harness Desktop **0.2.0-rc.2**
(Electron 44.0.0, host protocol 4) · bridge Node **24.21.0** · Codex Desktop and
Claude Code installed · execution environment: DSH Desktop agent session with the
`workspace-write` file policy and a **low-integrity restricted token**.

Legend: **PASS** verified here · **FAIL** verified broken · **BLOCKED** a real
external condition is missing · **NOT_RUN** not attempted.

Two environment facts drive most BLOCKED rows and are *not* product defects:

1. **The profile is locked by the running app.** `dsh plugin --profile desktop …`
   fails with `EPERM … package.json.lock`, and `dsh --profile desktop
   --dump-config` answers *"profile desktop is managed exclusively by the
   Electron application"*. Installing the connector therefore needs a Desktop
   restart, which this session cannot perform on the app that hosts it.
2. **This session runs at low mandatory integrity.** `icacls /inheritance:r`
   is denied (`Access is denied`) on every writable path, so the connector
   cannot establish a private directory *from this session*. It correctly
   refuses to publish instead of writing a readable credential file — that
   refusal is itself verified (A02).

| ID | Scenario | Status | Evidence / exact condition |
|---|---|---|---|
| A01 | Real Desktop identification | **BLOCKED** | Live `DeepSeek Harness.exe` (PIDs 21328/29728/30380, started 2026-10-14 09:45) confirmed by `Get-Process`; the descriptor-based resolver that would identify it is unit-tested (`host_identity_mismatch`, PID/start/listener checks). Not exercised against the running Desktop, because publication is blocked (A02). |
| A02 | Connection-file ACL | **PASS (refusal) / BLOCKED (positive)** | The connector refused to publish under an inherited-ACL directory: it created `<profileKey>/` and wrote **no** `identity.json`/`connection.json`. Unit tests assert inherited entries, `Everyone`/`Users`/`Authenticated Users`, empty policies and unexpected principals are all rejected, and that only this user + SYSTEM + Administrators are accepted. The positive path (ACL applied successfully) is BLOCKED by low integrity. |
| A03 | Log sanitization | **PASS** | `grep` over `src/`, `packages/`, `docs/`, `skill/`, `test/` finds no token, cookie or authenticated URL; `dsh_host_status` exposes only origin/versions/ids/capabilities; the connector's failure path logs a code only. The public-surface test also rejects machine-specific paths. |
| A04 | Authentication | **PASS (unit) / BLOCKED (live)** | Handshake implementation follows the installed `authorizeIndex`: one `303` + `dsh-auth-*` cookie, `redirect: "manual"`, 401 → `auth_rejected`, no anonymous fallback. Live exchange needs a published token. |
| A05 | Restart | **PASS (unit) / BLOCKED (live)** | `generationChanged` + `PairedHostAdapter.invalidate()` drop the generation (socket, cookie, late frames) and re-read the descriptor; `isGenerationFailure` covers `auth_required`/`stale_connection`/`host_identity_mismatch`. |
| A06 | Instance isolation | **PASS (unit)** | `hostId`+`instanceId` keyed generations; `endpointSnapshot` reports one origin per generation; cookie is authority-bound by the Host itself. |
| A07 | New task | **BLOCKED** | Requires a live authenticated Host. `session/create` mapping is unit-tested against the generated descriptor (`{request:{cwd,sessionId?,agentPreset?}}`). |
| A08 | Existing session | **PASS (unit)** | `dsh_attach_session` path never calls prompt/rename/selectModel; adapter `sessionSelectModel` refuses before sending (`CapabilityUnavailableError`, zero requests recorded). |
| A09 | Model and configuration | **PASS** | `loadConfig` rejects `DSH_BRIDGE_AGENT_PRESET`, `DSH_MODEL_POLICY≠inherit`, `DSH_APPROVAL_MODE≠desktop`, `DSH_ALLOW_REMOTE_HOST` and `DSH_HOST_URL` in paired mode; capability table sets `selectModel:false`; `modelPolicy:"inherit"`, `approvalMode:"desktop"` are reported in status. |
| A10 | Result relevance | **PASS (unit)** | Adapter keeps a per-session `requestId` (`lastPromptRequestId`) and history is read from `session/page` at the session's own `asOfSeq` cursor, so an older final turn is never re-reported as the new one. |
| A11 | Stream recovery | **PASS (unit)** | `session/follow` frames are validated as `snapshot`/`event`/`assistant-stream`; `snapshot.cursor` seeds `session/subscribed.lastSeq`; malformed frames are dropped rather than guessed. |
| A12 | Unknown write outcome | **PASS (design) / NOT_RUN (live)** | `session/prompt` always carries a stable `requestId` (`promptDedup:true`); the adapter never retries a write itself — only reads are retried after a generation failure. |
| A13 | Dual caller | **PARTIAL** | Two independent bridge processes each open their own stdio server, generation and cookie; shared state only under `DSH_BRIDGE_HOME`. Parallel/conflict behaviour continues to be covered by the upstream workspace-claim tests (which pass). End-to-end two-client run: BLOCKED with A07. |
| A14 | Control lease | **PASS (upstream)** | Upstream lease/claim tests pass in this run. |
| A15 | Native approval | **PASS (surface) / BLOCKED (live)** | The paired profile does not register `dsh_resolve_approval`/`dsh_answer_question` at all (asserted by the MCP-surface test), and the adapter refuses `respond()` with `CapabilityUnavailableError` before sending. `approval/asked` is mapped to an observable `approval/requested` frame only. A live approval round trip needs A07. |
| A16 | Cancel | **PASS (unit)** | `session/cancel` `{request:{sessionId}}` → `{accepted:true}`, target turn only; capability-gated. |
| A17 | Bridge exit | **PASS** | `index.ts` `shutdown()` stops the connection manager, adapter and MCP server; it never touches the Host process. |
| A18 | Install idempotency | **PASS** | Backed by 15 tests in `test/setup-desktop.test.ts`: sibling tables/keys preserved, own table replaced in place, second run classified `identical`, and a real dry-run → apply → re-plan cycle leaves the file unchanged. Every write goes through `atomicInstallText` with a backup. Launching the server over a space-containing path is BLOCKED with A07 (no live server). |
| A19 | Uninstall rollback | **PASS (unit)** | `applyCodexTable(content, undefined)` and `applyClaudeEntry(content, undefined)` delete only this build's table/entry; tests assert the sibling `[mcp_servers.other]` table and sibling JSON keys survive, and that unknown content stays put. |
| A20 | Codex live test | **BLOCKED** | Needs A02/A07. Recovery: quit Desktop → install connector → start Desktop → `setup-desktop --caller both --apply` → `verify-desktop` → one real Codex session. |
| A21 | Claude live test | **BLOCKED** | Same prerequisite as A20. |
| A22 | Unsupported version | **PASS** | `SUPPORTED_PROTOCOL_FAMILIES` gate throws `UnsupportedHostVersionError` for an unknown family before any request (unit-tested). |
| A23 | Observation without side effects | **PASS** | `session/list`, `session/projections`, `session/page` and `session/cancel` are read/cancel only; attach issues no prompt; the adapter sends no `session/selectModel` in paired mode. |
| A24 | Long task | **PASS (design) / BLOCKED (live)** | `dsh_wait` stays ≤30 s and an empty window is reported as a window, not a failure; `awaiting_approval`/`awaiting_input` are distinguished from disconnection. Live long-run: BLOCKED. |

## Test suite result

`node scripts/run-tests.mjs`: **257 tests, 245 pass, 12 fail**. Every failure is a
missing OS capability of this session, not a product regression:

- **9** need `symlink()` (blocked by this session's restricted token): *symlinked
  parent / config / skill targets*, *lock diagnostics symlink types*, two
  `findSessions … retargeted link` cases, *Claude symlinked `.mcp.json` and skill
  target*, *setup refuses symlinked config*, *setup engine symlinked/directory
  targets*, *setup engine snapshot non-file paths*.
- **3** need child processes with piped stdio (also blocked): *EventLedger two OS
  processes*, *bridge exits on stdin EOF*, *separate bridge reconnects after Host
  restart*.

The 47 new tests all pass:

- `test/desktop-cowork.test.ts` (32) — descriptor schema, local-origin fence,
  freshness, generation change, ACL parsing/policy, stream-frame validation,
  adapter wire mapping (`session/list`, `session/prompt` requestId, `session/page`
  asOfSeq cursor, blank session), capability refusal for model selection and
  interaction answers, unknown protocol family, every paired-configuration
  conflict, and the shared skill-semantics contract.
- `test/setup-desktop.test.ts` (15) — Codex table upsert/idempotency/sibling
  preservation/own-table removal, Claude entry round trip/refusal of a non-object
  config, plan classification (`absent` vs `identical` vs `differs`), a real
  dry-run → apply → re-plan idempotency cycle in a temporary directory, and the
  `dsh_desktop` server identity.

One upstream assertion was updated, not weakened: `public-surface.test.ts` pinned
the *upstream* `bin` map, and this private build renames its public commands
(`dsh-cowork-setup-desktop`, `dsh-cowork-doctor`, `dsh-cowork-verify-desktop`, …).
The `private: true`, MIT, repository-URL, LICENSE and NOTICE assertions are
untouched.

## `verify-desktop` on this machine (real output)

```
verify-desktop: BLOCKED
  ok   desktop-facts: Desktop 0.2.0-rc.2, profile desktop, connector registered false
  FAIL connection-file: the connector bundle is not registered in the Desktop profile;
       install dsh-desktop-cowork-connector through the official plugin mechanism, then
       restart the Desktop app; no connection descriptor under
       %LOCALAPPDATA%\DSHDesktopCowork\connections; the connector has not published yet
exit=2
```

This is the honest end-to-end status: the command performs the layering and stops
at the exact missing precondition instead of reporting a success it did not
observe.

## MCP surface

The server registers itself as **`dsh_desktop`** (not `dsh_agentlink`) and, in the
paired profile, does **not** register `dsh_answer_question` or
`dsh_resolve_approval` at all — the private build answers no Host interaction. The
legacy profile keeps the upstream surface for the RC6 regression path.

## Mock vs real

- **Real**: the Desktop runtime sources, versions, profile manifests and CLI
  behaviour were read from the installed 0.2.0-rc.2 release; the connector was
  mounted into a real `dsh web` Host profile and *did* activate, reach
  `ctx.webServer` / `ctx.connection`, create its connection directory and then
  refuse publication on the ACL check.
- **Mocked**: every wire interaction in the unit tests, through a fake
  `AuthSession` that records the exact requests.
- **Not reached**: any authenticated call to the user's own Desktop Host.

