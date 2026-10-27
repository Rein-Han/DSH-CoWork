---
name: codex-dsh-desktop
description: >-
  Delegate work to the running DeepSeek Harness Desktop Host, continue or attach
  to an existing DSH task, and collect its result over the dsh_desktop MCP server.
  Use when the user asks to hand work to DSH, continue DSH work, or check what DSH
  did, including 交给 DSH、让 DSH 做、继续 DSH 任务、DSH 做完了吗.
---

# Working with DSH Desktop from Codex

This skill uses one MCP server, `dsh_desktop`. It connects to the user's own
running DSH Desktop Host. It never starts a Host, never installs another
connector, and never opens a second channel "just this once" — if the tools are
missing, read the installation diagnostic and tell the user.

## Role boundary and delegation size

- The Main agent is the **Principal Agent and Tech Lead**: it owns requirements,
  architecture, technical decisions, sensitive approvals, cross-cutting
  integration judgment, review, and final acceptance.
- **DSH is the default engineering Worker** for independently executable bounded
  slices: routine implementation, refactoring, tests, lint/type/test repair,
  long-log analysis, and corrections from Main-agent review.
- For nontrivial engineering, decide the **delegation size** explicitly and
  delegate those slices by default with objective, workspace, constraints,
  evidence, and completion condition. Do not self-implement merely because DSH
  is optional or only allowed rather than required.
- Keep **small tasks** local only when delegation and **handoff cost** clearly
  exceeds doing them directly. Never generalize that exception into avoiding all
  engineering delegation. Read-only probes verify behavior; they do not replace it.
- Routine implementation and test repair suit the inherited **Flash** worker
  route. Architecture, difficult debugging, high-risk changes, and ambiguous
  decisions belong to the high-intelligence Main agent or a user-selected **Pro**
  route in DSH Desktop. `modelPolicy=inherit` remains mandatory; never switch models.

## First contact

1. `dsh_host_status` — confirm `reachable`, which adapter and protocol family
   were negotiated, and the declared capabilities.
2. If a tool is missing entirely, the server is not installed in this Codex
   configuration. Report the exact `setup-desktop --caller codex` command from
   [references/install-diagnosis.md](references/install-diagnosis.md) instead of
   improvising a connection.
3. If `reachable` is false, report its `errorCode` field. `connector_missing` and
   `stale_connection` mean the Desktop-side connector is not publishing; the fix
   is a Desktop restart, which the user performs.

## Path A — the user asks for something new

`dsh_delegate` with:

- `prompt`: the structured handoff (see below);
- `projectRoot`: the caller's current project root;
- `cwd`: the real requested task directory;
- `title`: a short display title;
- `waitSeconds`: `0` (detach, then supervise explicitly);
- `workspaceMode`: `"exclusive-write"` (default) when this task may modify files, `"read-only"` when it must not.

Always pass both `projectRoot` and `cwd`; the root must be `cwd` itself or its
ancestor. An explicit root reuses only an exact existing workspace or creates
one at that root, never a higher-level workspace. On Host 0.2.1-rc.2, selecting
a workspace forces the actual session cwd to `workspace.path`, so a subdirectory
task's session cwd and bridge claim are promoted to the project root. Keep the
input `cwd` in the prompt as task scope, not as a sandbox. Do not assign an
independent worktree to another project without explicitly widening the scope.
The caller name is attribution only and does not affect project selection.

Remember the returned `taskId` and `waitTarget.targetStartAfterCursor`.
Check `delegated.desktopWorkspace`: `workspaceId` is present, `created` is a
boolean, `resolution` is `exact`, `ancestor`, or `created`, `path` and
`sessionCwd` equal the canonical `projectRoot`, and `requestedCwd` equals the
canonical `cwd`. Also require
`workspaceClaim.cwd == desktopWorkspace.sessionCwd == desktopWorkspace.path`.
If evidence is missing or inconsistent, preserve the task and receipt, report
the attribution problem, and never re-delegate the same work.
For a queued follow-up, replace the wait target with the new receipt's target;
steering keeps the current target. Never retry a prompt whose outcome is unknown.

## Path B — continue a task you already started

`dsh_status` with the known `taskId`, then `dsh_followup` on the **same**
`taskId`. Never delegate a fresh task for work DSH already owns.

## Path C — continue a specific existing DSH Desktop session

`dsh_find_sessions` first, then `dsh_attach_session` with the exact `sessionId`
and the preconditions it returned. Attaching sends no prompt, renames nothing,
and selects no model. Only after a successful attach, use `dsh_followup`. If more
than one session could be the intended one, show the candidates and ask — do not
pick by title.

## Handoff content

Objective; deliverable; `projectRoot`; the requested `cwd` as task scope; what
may be modified; what is already done; relevant paths; constraints and versions;
the acceptance commands; the shape of the answer you need. No chat transcripts,
no internal reasoning, no secrets.

## While it runs

Check `dsh_host_status.observation` for supported options. Use:

```json
{"taskId":"<receipt taskId>","until":"terminal","responseMode":"compact","timeoutSec":30}
```

Include the receipt's `targetStartAfterCursor` on every wait for that run.
Resume with `sinceCursor=nextCursor`. Ordinary tool events stay inside the bridge.
The result reports `wakeReason`, `execution`, `availability`, `nextCursor`,
`connectionRevision`, `pendingInteractions`, and `finalMessageStatus`.
Use `change` only for deliberate phase inspection; fetch `dsh_tail` on demand.
An empty timeout is normal: continue the user's authorized task and provide
useful progress updates. There is no fixed number of timeouts after which to quit.
Keep the task and cursor if the client genuinely cannot continue; do not claim
background notifications exist. Canceling observation does not cancel DSH.

For a natively verified client with profile `adaptive` (or `long`), replace
`timeoutSec:30` above with `schedule:"adaptive",observationPolicy:"supervised"`.
The bridge selects 60/120/180/300 seconds at run ages <5/5–10/10–15/≥15 minutes.
It watches events continuously and returns early for completion, interaction,
connection/recovery problems or three consecutive observed tool failures.
Each new queued run starts its own age; recent steer keeps 60 seconds for two minutes.
Keep `timeoutSec:30` (30 seconds) on bounded/unverified clients; never infer verification from
configuration or an SDK test. An explicit shorter timeout is available for a planned
stage review. Legacy `dsh_observe` and delegate's embedded wait stay change/full;
use standalone `dsh_wait` for the new policy. Explicit change/full remains supported.
At each adaptive timeout, assess the current stage; request only needed incremental
`dsh_tail` evidence, not unconditional full status/history. Successful tools alone
do not prove correct direction. A `supervision` wake is a candidate problem, not
a task failure: inspect evidence and decide whether guidance is needed.
Advance `sinceCursor` to acknowledge inspected failures. Do not hot-loop an unchanged
interaction/fault; if deliberately waiting after handling it, pass its `wakeKey` as
`acknowledgedWakeKey`. Never wait again after an accepted terminal result.
Progress notifications do not extend the caller's hard timeout. If a wait is
backgrounded, retain its caller task handle and collect that result; do not start
another wait while it is pending. After observer cancellation or client timeout,
inspect the same DSH task and resume its target; never repeat delegation.
For client acceptance, configuration and rollback, read
[references/long-wait.md](references/long-wait.md). A timer-only acceptance tool
tests the caller, not DSH completion or workspace release.
If the server lacks these options, use the bounded legacy wait and report the
upgrade requirement; do not repeatedly send rejected options.

`awaiting_approval` / `awaiting_input` means the **user** must act in DSH
Desktop. Say so plainly; there is no tool here that answers it.
Do not immediately repeat waits for the same unresolved interaction. Resume
when the user has acted or a deliberate status check establishes a change.
If the client already has a background wait, collect that result instead of
creating another wait for the same run.

## When it finishes

Fetch the complete result once with `dsh_status` if the same run remains current.
If another run has begun, use `dsh_tail` with `sinceCursor=finalMessageAfterCursor`
and `maxEvents=1`, then verify the event's session/seq matches `finalMessagePointer`.
Tail accepts a numeric cursor, not a pointer object. A truncated/unavailable body
is not a complete result. `ambiguous_wait_target` or `unverified_wait_target`
requires inspecting task history and result ownership; never resend the prompt.
A compact summary is not the deliverable. Verify it yourself: inspect the changed files or diff, run
the acceptance commands, compare with the request. DSH completing a turn is not
acceptance. If it fell short, `dsh_followup` the same `taskId`.

Then call `dsh_release_workspace` for the claimed directory. It reads fresh
Desktop inbox/jobs evidence even when status's mux queueDepth remains unknown.
Success releases the bridge claim, preserving the session and history.
If it reports
`session_busy` or `workspace_state_unknown`, preserve the claim and explain the
remaining evidence; do not bypass the guard. Tell the user what
DSH produced, what you verified, and anything still open.

## Invariants

- Model, reasoning effort, and agent preset are **inherited**; never pass them.
- One writer per directory tree; parallel writes need disjoint directories.
- Approvals and questions stay in the Desktop UI.
- The taskId is the identity of a task; a title is not.

The full rule set is in [references/cowork-semantics.md](references/cowork-semantics.md);
the error-to-remedy table is in [references/error-codes.md](references/error-codes.md).
