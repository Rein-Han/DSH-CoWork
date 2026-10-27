# Adaptive Desktop observation (policy version 3)

Baseline: local tag `v0.1.1`, commit `bef97104f60405931b7a183b2ebc09700475f5ce`.
This change is restricted to observation, summaries, wait configuration and TOML editing.
Task dispatch, workspace ownership, prompt routing, queue/steer sending, target-run
attribution, Host adapters, cancellation and release guards retain their baseline code.
Check this boundary with `node scripts/check-observation-boundary.mjs`.

## Contract

| Entry | Defaults / compatibility |
| --- | --- |
| Desktop standalone `dsh_wait` | `terminal`, `compact`, supervised failure candidates |
| `DSH_WAIT_POLICY=legacy` or legacy MCP surface | Previous `change/full`, 30 seconds |
| Explicit `until:change,responseMode:full` | Previous ordinary-change observation, maximum 30 seconds |
| `dsh_observe` | Previous `change/full` alias, 0–30 seconds |
| Delegate embedded wait | Unchanged; use detached delegation and standalone wait for the new policy |
| `observationPolicy:terminal` | Terminal/interaction/availability/recovery only; no failure-candidate alerts |

`DSH_WAIT_PROFILE` is a deployment choice, independent of caller name:

- `bounded` (default): maximum 30 seconds. Safe fallback when native long calls are unverified.
- `adaptive`: maximum 300 seconds; omitted timeout selects a run-age budget.
- `long`: preserves explicit terminal waits up to 900 seconds; omitted timeout uses the same adaptive budget.

For an accepted adaptive deployment:

```json
{"taskId":"<actual taskId>","until":"terminal","responseMode":"compact","schedule":"adaptive","observationPolicy":"supervised","targetStartAfterCursor":0}
```

Replace the example anchor with the **actual receipt's** value, and on subsequent
observations include `sinceCursor` from the previous `nextCursor`. Never invent an
anchor or resend a task because an observer timed out. A queued follow-up supplies
a new anchor; steering retains the current anchor. These rules and their implementation
have not changed.

| Age of the observed current run at wait start | Budget |
| --- | --- |
| < 5 minutes | 60 seconds |
| 5–10 minutes | 120 seconds |
| 10–15 minutes | 180 seconds |
| ≥ 15 minutes | 300 seconds |

The monotonic deadline includes initial synchronization. Ordinary events do not
extend it, and crossing a tier during a wait does not trigger a model step. The
ledger's observed turn-start time survives process restart. Missing/future time or
an unstarted target uses 60 seconds, not an invented age. This is observed age, not
provider billing/runtime telemetry. A steer observed within the last two minutes
temporarily selects 60 seconds. Explicit `timeoutSec` selects a fixed observation;
with `schedule:adaptive` it caps the chosen budget, allowing an earlier review.

## Early communication and supervision

The existing stream and shared ledger observer keep running during a long wait.
Completion, failure, cancellation, interruption, pending interactions, unavailable
Host or recovery problems still return early. Desktop approvals/questions remain
in the Desktop UI; no new tool answers them.

New supervised observation also reports a candidate after three consecutive
observed failed tool results from the same source session. Only a boolean result
bit is persisted, not tool output/error bodies. This does not classify root cause
or prove that every Host problem is visible. Older records do not contain this bit.
A streak emits one issue cursor; additional retries in that streak do not emit
another. Success resets the count; a new root turn resets the derived index.
The evidence is reconstructed incrementally from the existing ledger, including
after bridge restart. No task state or message is modified by this index.

Inspect a candidate before deciding to guide the worker. Advance `sinceCursor`
after inspecting it. Unchanged interaction/unavailability/recovery states produce
a stable `wakeKey`. If intentionally continuing to observe an already-handled state,
pass `acknowledgedWakeKey`; the bridge then waits internally until a different
meaningful state or the deadline. Do not blindly acknowledge a new problem or loop
after terminal completion. Awaiting a human response is not a reason to re-delegate.

At each periodic timeout assess stage progress and direction. Fetch only the
incremental evidence required for that decision. Successful tools can still be
working in the wrong direction; this policy cannot detect semantic drift by itself.
The 300-second tier can delay a purely semantic inspection by almost five minutes.
Use a shorter explicit timeout when that is unacceptable.

Compact replies use compact JSON, project at most four interaction identities,
report the total count, and point to `dsh_status` for full details. Final answers are
not inlined: preserve and verify `finalMessagePointer` / `finalMessageAfterCursor`.
Fetch the complete answer once for acceptance. Missing/truncated content is not
success. Progress notifications are transport notifications, not model heartbeats;
they do not guarantee extension of a client's hard timeout.

## Setup, verification and rollback

Preview a single client's change, using the intended scope:

```powershell
node dist/setup-desktop.js --caller kimi-code --scope user --wait-profile adaptive --replace --dry-run
# After native acceptance and review of that plan:
node dist/setup-desktop.js --caller kimi-code --scope user --wait-profile adaptive --replace --apply
```

The same profile is available for `codex`, `claude`, `zcode` and the `kimi-work`
export. No caller name is banned from extended waits. The installer does not mark
native acceptance as passed. Without `--wait-profile`, an existing profile is
preserved. Runtime defaults remain bounded when no profile is configured.

Codex uses a minimum `tool_timeout_sec=360`; Claude uses per-server `timeout=360000`;
Kimi Code uses `toolTimeoutMs=360000`. Explicit long uses 960/960000. Larger existing
values and unrelated settings survive. ZCode's timeout field is not guessed: its
native limit must be measured. Kimi Work still requires its supported manual MCP
and skill import path; an export is not an installed integration.

Only changed files are backed up by the existing installer. To restore wait fields
from an installer backup (dry-run by default):

```powershell
node dist/rollback-wait-profile.js --caller kimi-code --profile adaptive --backup <backup-path>
# Add --apply only after reviewing; --project <path> for project scope.
```

Supported rollback callers: Codex, Claude, Kimi Code, ZCode. The expected installed
profile must match; a later profile change is preserved. Timeout rollback restores
only the installer's known margin when it raised the old value. Larger/later user
values, other servers and custom env fields survive. Full legacy observation can
also be selected with `DSH_WAIT_POLICY=legacy`; this is separate from the time budget.

Required acceptance before broad activation:

1. Native client: 60/120/180/300-second waits; ordinary events absorbed; critical
   events early; exact result retrieval. Background handles must be collected, not
   replaced with duplicate waits. SDK tests cannot prove native UI behavior.
2. Native user input and observer interruption; multiple pending tasks without
   serial starvation. Canceling one observer must not cancel DSH or another observer.
3. Real Desktop: dispatch → steer delivered → complete answer → queue a new run
   on the same task → completion → fresh inbox/jobs evidence → release → another
   write in the same directory. Mock `known:true` queues are insufficient.
4. Budget/cost: count main-model steps, waits, status/tail reads, and input/cache/output
   usage on comparable work. Fewer waits are not a guaranteed proportional quota saving.

## TOML scope

Both Desktop and retained legacy installers now recognize decoded quoted/escaped
keys and respect table scope. Root inline `mcp_servers` cannot be extended safely
and is rejected before writing. A similarly named key under an unrelated table
does not block installation. Duplicate aliases are rejected. Desktop preserves
custom fields, inline env and sibling servers, and is idempotent. Existing nested
Desktop `.env` tables and multiline strings are conservatively refused rather than
rewritten unsafely. The legacy installer's explicitly requested replacement/migration
semantics remain unchanged; this patch fixes its parser guards, not its routing setup.

## Evidence locations

Local acceptance records and raw logs are intentionally outside this source
repository. In the development workspace, see `project-notes/` and
`analysis/adaptive-wait-2026-10-27/` at the parent level. The 2026-10-27
follow-on run built the product, passed 338/344 tests (six symlink fixtures
failed at creation with Windows `EPERM`), verified observer cancellation and
real Desktop release, but did not resolve native Codex result queuing or the
previous intermittent completion delay. This source tag does not install or
enable an adaptive profile, rebuild the older installer, or certify native clients.
