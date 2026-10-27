# Known issues

## Open items after the 0.2.1 observation work

### Follow preemption may delay another task's live updates (P2, deferred)

When more than 24 root sessions compete for Desktop `session/follow` slots,
running sessions rank ahead of idle ones, and an active wait takes priority.
This can displace another session's follow. That session's completion or
pending interaction may reach its main agent later,
after it is followed again or explicitly reconciled by a status read. This
changes which task bears the observation delay; it does not cancel a DSH task,
resend a prompt, or establish that conversation content was lost. Defer a
behavior change for P2; do not claim it is resolved without testing parallel
tasks through the real Desktop entry point, displacement, recovery, and
descendant history.

### Native Codex short-result delivery may queue behind a long call

Observed in the native caller: a short task had completed but its result was
not delivered to the main conversation until a separate long wait returned.
The SDK timer-only control returned the short result in about three seconds
while the long call took about 25 seconds. This does not identify which native
dispatch, collection, or delivery stage is responsible, nor prove the native
behavior is fixed. Keep extended/adaptive waits opt-in until that client path
is reproduced and verified with separate send/server-complete/client-receive/
conversation-resume timestamps. Do not re-dispatch a completed task just to
work around a missing notification.

### An orphaned fail-closed `events.lock` can block one task

A lock directory remains in this machine's shared bridge home for a different
task, with an owner PID that was not running when checked. The bridge reported
`pending baseline reconciliation` lock acquisition timeouts. This may block
operations touching that task's ledger and warrants controlled local recovery;
it is not established as the cause of the earlier completion-notification
delay. Never auto-delete a lock based only on PID/mtime, and do not remove a
shared bridge home or a broad parent directory. See the crash-recovery section
below before any manual action.

### Six Windows symlink-security tests are unverified

On this Windows machine, six test fixtures fail with `EPERM` while creating
symbolic links. The security assertions never execute: this is a verification
gap, not six demonstrated product defects. Re-run those cases in an environment
with symlink creation rights; do not silently skip or report them as passing.
The product source build passes independently. The test runner also emits 16
pre-existing TypeScript diagnostics in test sources before executing emitted
JavaScript; a green runtime subset is not a clean test type-check.

### Windows junction parent bypasses the Codex skill installation guard (deferred)

On this machine, the test that creates a junction at the project's `.agents`
directory reaches `prepareCodexSkillInstall` but does not get the expected
rejection. Node reports that junction as a directory, not a symbolic link, so
the parent-directory guard's `isSymbolicLink()` check misses it. A prepared
installation can therefore target the junction's destination instead of the
apparent project path. This is a confirmed guard failure, not evidence that a
user's installation has been redirected. Leave the guard unchanged for now;
do not count this test as an environment-only failure.

### Other confined-Windows test failures

The October 28, 2026 full run passed 341 of 354 tests, including all ten
observation-coverage tests. Besides the six symlink fixture failures and the
junction guard above, two canonical-cwd tests failed while removing a junction
fixture (`ERR_FS_EISDIR`) before their retargeting assertions; three process
tests could not spawn child processes (`EPERM`), and a Windows process-facts
test could not observe the current process in this sandbox. These are
verification gaps on this runner, not demonstrated product regressions. The
strict product build passed; `npm run check` exited 1.

## Shared coordination ledger can fail on a duplicate cursor

Status: fixed in `0.1.0-alpha.2`.

A duplicate task cursor was observed when multiple bridge processes, including processes from different builds, shared the same `DSH_BRIDGE_HOME`. The affected task ledger then reported `unrecoverable_gap`; in the observed run, the rejected ledger queue also caused the MCP transport process to exit.

The root cause included two unsafe check-then-delete paths. A process that lost the race between creating a lock directory and writing its `owner.json` could delete a replacement lock. Separately, automatic stale-lock reaping could rename and delete a freshly reacquired lock based on an older mtime/PID observation.

The fixed implementation retries owner writes that lose with `ENOENT` or `EEXIST` without deleting the current lock directory. After a failed `mkdir`, an unexpected owner-write error never removes the current path: the process cannot prove that the still-empty directory is its own attempt (a competitor may have replaced it before writing its `owner.json`), so it fails closed and leaves the path untouched. Automatic stale reaping is disabled and fails closed because Node's portable filesystem APIs cannot atomically compare a stale observation with a later destructive rename. Deterministic regression tests cover lost owner writes, stale observations, preservation of competing owners, and preservation of a competitor's still-empty replacement directory. The doctor does not try to diagnose those historical race paths; it reports only the currently observed state of the known lock locations, and it does so read-only.

Upgrade requirement: every bridge process sharing one `DSH_BRIDGE_HOME` must be restarted onto the fixed build. One remaining `0.1.0-alpha.1` process can still race with a fixed process because the old process does not follow the corrected ownership rules.

When upgrading or recovering an affected installation:

- close or restart every Codex task that still runs the previous bridge build;
- do not run different dsh-Agentlink builds against the same `DSH_BRIDGE_HOME`;
- give concurrently active build or instance groups separate `DSH_BRIDGE_HOME` directories;
- preserve a failed bridge home for diagnosis instead of deleting it blindly; use a fresh bridge home to resume new delegations.

DSH conversation history remains owned by the DSH Web Host. Using a fresh bridge home does not delete DSH sessions, but existing bridge task ids, workspace claims, and task cursors are not automatically migrated.

### Crash-recovery trade-off

The lock is intended for short critical sections on one local filesystem. It has no heartbeat, its PID/mtime observations are not valid on NFS, and the fixed build does not automatically delete an apparently stale lock. A process that is hard-killed while holding a lock can therefore leave an exact lock directory that causes later operations to time out. An unexpected `owner.json` write failure such as `ENOSPC` or `EIO` can also leave an empty fail-closed lock directory, because the bridge cannot prove the directory still belongs to its own attempt. Stop every bridge process using that bridge home, preserve a backup, and inspect the exact owner before any manual cleanup; never delete the bridge home or a broad parent directory blindly.

### Doctor reports fail-closed locks read-only and never cleans them

`npm run doctor` reports only the currently observed structure of each known fail-closed lock location under the bridge home — `claims/registry.lock` and `ledgers/<valid task id>/events.lock`. It reports path/owner presence and filesystem type plus bounded entry observations. It never opens or parses `owner.json`, and never reports its pid, token, `createdAt`, or other contents. These are point-in-time observations, not race-proof ownership or liveness conclusions. Both the ledgers scan and each lock-directory scan stop after a bounded max-plus-one observation and explicitly report truncation. The doctor never creates, deletes, renames, chmods, rewrites, or acquires a lock, never declares one safe to delete, and never auto-cleans one.

### Existing large ledgers are not compacted by this patch

The patch prevents new top-level `session/projection` snapshots and high-frequency assistant stream chunks from inflating the durable ledger; `session/jobs` remains durable, with its payload scrubbed by the existing coordination-only rules. It does not rewrite or compact an existing 5 MB+ ledger. Preserve the old bridge home for inspection. New delegations may use a separate `DSH_BRIDGE_HOME`, but its task ids, cursors, and claims start fresh. DSH `session.history` remains the conversation source of truth; changing bridge home does not delete Host sessions. No automatic cleanup command is provided.

## Windows reports limited POSIX mode bits

Windows access control is ACL-based, and Node.js does not round-trip Unix `0600`, `0640`, or `0700` mode bits there. Files and directories created with those requested modes are commonly reported as `0666` by `stat`. Setup and persistence tests therefore require exact POSIX modes on Unix-like systems and verify Windows' supported representation separately; they do not treat Windows mode bits as an ACL audit.

The setup engine still refuses symlinked or non-regular config targets, checks stale snapshots before replacement, creates same-directory backups, and verifies the exact installed content. This portability boundary does not grant broader filesystem access or modify Windows ACLs.
