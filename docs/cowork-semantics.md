# Cowork semantics (canonical)

Both `codex-dsh-desktop` and `claude-dsh-desktop` are generated from this page.
Each skill carries its own copy under `references/cowork-semantics.md`, so an
installed skill never reaches into another skill's directory. A test asserts that
the canonical page and both copies state the same rules.

## Roles

- **Main agent** (the current Codex or Claude Code session): decomposes the work,
  decides what DSH should do, writes the handoff, supervises, and **accepts the
  result itself**. DSH finishing is not the same as the work being accepted.
- **DSH Desktop**: runs the task in the user's own already-running Desktop Host,
  using DSH's native sessions, tools, files, and permissions. It is not a
  subagent of the main agent and does not inherit its context.
- **Bridge (`dsh_desktop` MCP server)**: connects, dispatches, observes, and
  stores coordination metadata. It is not a second model runtime and never owns
  a conversation body.

## Three session paths

1. **Same known task** — keep the exact `taskId` from the earlier call. Read the
   latest status, then `dsh_followup`. Never re-delegate a task the user already
   gave DSH.
2. **User names an existing DSH session** — `dsh_find_sessions`, confirm exactly
   one intended root session by `sessionId` plus its `updatedAt`/`cwd`/title
   preconditions, then `dsh_attach_session`. Attaching sends no prompt, renames
   nothing, and selects no model. Continue with `dsh_followup` only after the
   user's intent is clear.
3. **New independent work** — `dsh_delegate` with the project's real `cwd`.
   Never use the bridge installation directory as the working directory.

A title is a display aid, never an identity. If the match is ambiguous, return
the candidates and ask; if the user has not asked to continue an old session,
create a new one.

## Handoff summary

The `prompt` is a compact structured brief, not a transcript:

- objective and expected deliverable;
- `cwd` and the allowed scope of modification;
- what is already done and which paths matter;
- constraints (versions, commands that must pass, things not to touch);
- acceptance evidence to return (diff summary, commands, outputs);
- the shape of the answer you want back.

Never upload the whole chat, internal reasoning, secrets, or large file bodies.
Reference paths that the DSH Host can actually read.

## Model, preset, and approval policy: inherit

- Never pass a model, reasoning effort, or agent preset. The Desktop Host's own
  default applies, and an existing session keeps its own selection.
- Never change global plugins or approval policy from the bridge.
- `dsh_desktop` reports `modelPolicy: inherit` and `approvalMode: desktop`. When
  the user wants a different model, they set it in DSH Desktop.

## Single writer

One directory (and its parents/children) has one writer. Two tasks that write
must use disjoint directories or separate worktrees. `dsh_delegate` claims the
workspace; a conflicting claim is refused rather than queued. Only the process
holding the control lease may prompt, steer, or cancel; every other caller is
read-only for that task.

Release the claim with `dsh_release_workspace` **after** you have reviewed the
result. While the session is running, queued, awaiting approval, or awaiting
input, releasing is refused.

## Waiting

`dsh_wait` returns within 30 seconds and reports `cursor`, `execution`,
`availability`, `pendingInteractionSummary`, and `finalResultPointer`. An empty
window is not a failure. Keep supervising and give the user a short progress
update; for long work, return control to the user and resume later by `taskId`.

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
