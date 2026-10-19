---
name: codex-dsh-desktop
description: Delegate work to the DeepSeek Harness Desktop Host already running on this machine, continue an existing DSH task, attach to a specific existing DSH Desktop session, and collect and accept its execution result over the dsh_desktop MCP server. Use when the user says "hand this to DSH", "ask DSH", "continue the DSH task", "check what DSH did" (or in Chinese: "交给 DSH", "让 DSH 做", "继续 DSH 任务", "DSH 做完了吗"), or wants a long task executed in DSH Desktop instead of this Codex session.
---

# Working with DSH Desktop from Codex

This skill uses one MCP server, `dsh_desktop`. It connects to the user's own
running DSH Desktop Host. It never starts a Host, never installs another
connector, and never opens a second channel "just this once" — if the tools are
missing, read the installation diagnostic and tell the user.

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
- `cwd`: the real project directory;
- `title`: a short display title;
- `workspaceMode`: `"exclusive-write"` (default) when this task may modify files, `"read-only"` when it must not.

Remember the returned `taskId` for the rest of the workstream.

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

Objective; deliverable; `cwd`; what may be modified; what is already done;
relevant paths; constraints and versions; the acceptance commands; the shape of
the answer you need. No chat transcripts, no internal reasoning, no secrets.

## While it runs

`dsh_wait` returns in at most 30 seconds with `cursor`, `execution`,
`availability`, `pendingInteractionSummary`, and `finalResultPointer`. An empty
window is normal for long work — report progress, wait again, or stop and resume
later with the same `taskId`.

`awaiting_approval` / `awaiting_input` means the **user** must act in DSH
Desktop. Say so plainly; there is no tool here that answers it.

## When it finishes

Read the result, then verify it yourself: inspect the changed files or diff, run
the acceptance commands, compare with the request. DSH completing a turn is not
acceptance. If it fell short, `dsh_followup` the same `taskId`.

Then `dsh_release_workspace` for the claimed directory, and tell the user what
DSH produced, what you verified, and anything still open.

## Invariants

- Model, reasoning effort, and agent preset are **inherited**; never pass them.
- One writer per directory tree; parallel writes need disjoint directories.
- Approvals and questions stay in the Desktop UI.
- The taskId is the identity of a task; a title is not.

The full rule set is in [references/cowork-semantics.md](references/cowork-semantics.md);
the error-to-remedy table is in [references/error-codes.md](references/error-codes.md).
