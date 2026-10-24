# Cowork semantics (canonical)

Each of the five caller skills carries its own copy under
`references/cowork-semantics.md`, so an installed skill never reaches into
another skill's directory. A test asserts that the canonical page and all five
copies state the same rules.

## Roles

P3 adds opt-in long waiting, token-only progress, incremental locked ledger reads
and task-shared observation polling. The default remains bounded until the exact
client/version/entry passes native acceptance. See `long-wait.md` in this same
directory for configuration, rollback, capability limits and acceptance tools.
The server's `clientLongWaitVerified=false` is not an assertion that long calls
fail; the server cannot certify a caller UI from its environment.

- **Main agent** (the current caller session): decomposes the work, decides what
  DSH should do, writes the handoff, supervises, and **accepts the result
  itself**. DSH finishing is not the same as the work being accepted.
- **DSH Desktop**: runs the task in the user's own already-running Desktop Host,
  using DSH's native sessions, tools, files, and permissions. It is not a
  subagent of the main agent and does not inherit its context.
- **Bridge (`dsh_desktop` MCP server)**: connects, dispatches, observes, and
  stores coordination metadata. It is not a second model runtime and never owns
  a conversation body.

## Delegation boundary and size

- The **Main agent is the Principal Agent and Tech Lead**. It owns requirement
  interpretation, architecture, technical decisions, sensitive approvals,
  cross-cutting integration judgment, review, and final acceptance.
- **DSH is the default engineering Worker** for independently executable bounded
  slices: routine implementation, refactoring, tests, lint/type/test repair,
  long-log analysis, and corrections requested by the Main agent's review.
- For nontrivial engineering, decide the **delegation size** explicitly. Give each
  slice an objective, workspace, constraints, expected evidence, and completion
  condition, then delegate it by default. Keep cross-slice decisions and
  integration judgment in the Main agent; do not self-implement merely because
  DSH is optional or only allowed rather than required.
- Keep **small tasks** in the Main agent only when the delegation and
  **handoff cost** clearly exceeds doing them locally. This exception must not
  become a blanket reason to avoid engineering delegation. Read-only connectivity
  or grouping probes are acceptance tools, not a substitute for implementation.
- Routine implementation and test repair suit the inherited **Flash** worker
  route. Architecture, difficult debugging, high-risk changes, and ambiguous
  decisions belong to the high-intelligence Main agent or a user-selected **Pro**
  route in DSH Desktop. These are role guidelines only: `modelPolicy=inherit`
  remains mandatory and the bridge never switches models automatically.

## Three session paths

1. **Same known task** — keep the exact `taskId` from the earlier call. Read the
   latest status, then `dsh_followup`. Never re-delegate a task the user already
   gave DSH.
2. **User names an existing DSH session** — `dsh_find_sessions`, confirm exactly
   one intended root session by `sessionId` plus its `updatedAt`/`cwd`/title
   preconditions, then `dsh_attach_session`. Attaching sends no prompt, renames
   nothing, and selects no model. Continue with `dsh_followup` only after the
   user's intent is clear.
3. **New independent work** — `dsh_delegate` with the caller's current project
   root as `projectRoot` and the real task directory as `cwd`. Never use the
   bridge installation directory as the working directory.

A title is a display aid, never an identity. If the match is ambiguous, return
the candidates and ask; if the user has not asked to continue an old session,
create a new one.

## Workspace selection and evidence

For new work, pass both `projectRoot` and `cwd`. `projectRoot` is the caller's
current project root; `cwd` is the requested task directory. `projectRoot` must
be `cwd` itself or its ancestor. The caller name is attribution metadata only
and never participates in workspace selection.

With an explicit `projectRoot`, reuse an existing workspace only when its path
is exactly that root; if none exists, create a workspace only at that root. Do
not fall back to a higher-level workspace. When `projectRoot` is omitted, reuse
the nearest existing workspace at `cwd` or one of its ancestors; if none exists,
create one at `cwd`. Existing sessions are not moved by this selection logic,
and other legacy behavior remains unchanged.

Host 0.2.1-rc.2 does not allow `workspaceId` together with `cwd` when creating a
session. Once a workspace is selected, the actual session cwd is forced to
`workspace.path`. For a subdirectory task, both the real session cwd and the
bridge claim are therefore promoted to the project root. The input `cwd` still
belongs in the prompt as the task scope; it is not a filesystem sandbox. An
independent worktree must not be assigned to another project without explicitly
widening the task scope.

Check `delegated.desktopWorkspace` before treating project attribution as
verified. It contains `workspaceId`, `path`, `created`, `resolution`,
`requestedCwd`, and `sessionCwd`; `resolution` is `exact`, `ancestor`, or
`created`. With an explicit root, `path` and `sessionCwd` must equal the
canonical `projectRoot`, while `requestedCwd` must equal the canonical requested
`cwd`. Also check that
`workspaceClaim.cwd == desktopWorkspace.sessionCwd == desktopWorkspace.path`.
Missing or mismatched evidence means attribution is not verified: preserve the
task and receipt, report the problem, and do not delegate the same work again.

## Handoff summary

The `prompt` is a compact structured brief, not a transcript:

- objective and expected deliverable;
- `projectRoot`, the requested `cwd`, and the allowed scope of modification;
- what is already done and which paths matter;
- constraints (versions, commands that must pass, things not to touch);
- acceptance evidence to return (diff summary, commands, outputs);
- the shape of the answer you want back.

Never upload the whole chat, internal reasoning, secrets, or large file bodies.
Reference paths that the DSH Host can actually read. When the actual session cwd
is promoted to the project root, keep the requested `cwd` explicit in the prompt
as the task scope rather than implying that DSH is confined to that directory.

## Model, preset, and approval policy: inherit

- Never pass a model, reasoning effort, or agent preset. The Desktop Host's own
  default applies, and an existing session keeps its own selection.
- Never change global plugins or approval policy from the bridge.
- `dsh_desktop` reports `modelPolicy: inherit` and `approvalMode: desktop`. When
  the user wants a different model, they set it in DSH Desktop.

## Single writer

One directory (and its parents/children) has one writer. Two tasks that write
must use disjoint directories or separate worktrees. `dsh_delegate` claims the
selected `workspace.path`, which may be an ancestor of the requested `cwd`; a
conflicting claim is refused rather than queued. Only the process holding the
control lease may prompt, steer, or cancel; every other caller is read-only for
that task.

Release the claim with `dsh_release_workspace` **after** you have reviewed the
result. While the session is running, queued, awaiting approval, or awaiting
input, releasing is refused. Desktop release reads a fresh sequenced
`session/projections.values.inbox` and the first complete `job/list` rows snapshot
for the root and known descendants. Running/stopping jobs (including visible
unowned jobs) block release; completed/failed/killed jobs do not. Cached, missing,
malformed or unavailable evidence returns `workspace_state_unknown` and preserves
the claim. No synthetic empty baseline or force bypass is used.
Release rechecks lineage/ledger and compares the claim under the registry lock.
These reads do not form a Host atomic fence against Desktop UI or other clients.
The release result identifies its evidence source; normal status queueDepth may
remain unknown because its mux cache is separate from this on-demand check.

Steer requires an active root turn; a turn change during its preflight returns
`stale_view` before dispatch. Queue and steer writes are never automatically
retried. Observation revisions are task-scoped; the public connection revision
still retains its original write-freshness meaning.

## Waiting

Delegate with `waitSeconds=0`, retain `waitTarget.targetStartAfterCursor`,
then explicitly wait with `until=terminal,responseMode=compact,timeoutSec=30`.
Pass that target on each wait and resume from `nextCursor`.
The summary reports `execution`, `availability`, `wakeReason`,
`connectionRevision`, `pendingInteractions`, and `finalMessageStatus`.
Read complete results using `dsh_status` or `dsh_tail` once they are available.
Ordinary events remain in the ledger; explicit `change/full` still supports
phase inspection, steer/cancel and diagnosis. Old omitted options remain change/full.
Timeouts are normal and do not cancel DSH. Continue existing authorized work;
no fixed timeout count means completion or permission to abandon supervision.
Canceling a wait only removes that observer. No waiter means no loss of task events.
Long mode is opt-in after independent client validation; configuration alone
does not prove interrupt/concurrency/background support. No notifications are promised.

## Interactions belong to the Desktop UI

Approvals and DSH questions are answered by the human in DSH Desktop. The private
build registers no approval-answer or question-answer tool and never fakes one
through a prompt. When a task is `awaiting_approval` or `awaiting_input`, tell
the user to handle it in DSH Desktop, then wait again. If the protocol does not
expose the interaction body, say it is unknown instead of inventing a question.

## Acceptance

Before reporting success, the main agent checks the actual artifacts: read the
changed files or the diff, run the stated tests, and compare against the request.
`turn_completed` ends one run; it does not prove the goal was met. If the result
is incomplete, `dsh_followup` on the **same** `taskId` instead of delegating a
fresh task.

## Task identity and errors

A `taskId` survives turns, so keep it. Report the bridge's stable error codes
(`desktop_not_running`, `connector_missing`, `connection_file_insecure`,
`stale_connection`, `auth_required`, `auth_rejected`, `unsupported_host_version`,
`protocol_mismatch`, `capability_unavailable`, `session_busy`, `workspace_conflict`,
`write_outcome_unknown`) rather than a generic failure. `unsupported_host_version`
and `capability_unavailable` mean this build cannot serve that Host: install a
matching build instead of retrying or improvising another connection.
