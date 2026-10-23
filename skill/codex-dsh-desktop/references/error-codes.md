# Bridge error codes and remedies

| Code | Meaning | What the caller does |
|---|---|---|
| `desktop_not_running` | The Host named by the descriptor is gone, or nothing listens on its origin. | Ask the user to start **DeepSeek Harness Desktop**. Never start a Host yourself. |
| `connector_missing` | No `connection.json` for this profile, or the file does not match schema version 1. | The connector bundle is not installed or has never run. Give the user the installer line from `install-diagnosis.md`, then a Desktop restart. |
| `connection_file_insecure` | The private directory or file is readable by another ordinary account, or the path goes through a reparse point. | Refuse to connect. The fix is the connector's ACL step; never relax the check and never copy the token elsewhere. |
| `stale_connection` | `publishedAt` is older than the 30s refresh contract, or dated in the future. | Treat the Host as restarted or stopped. Re-read the descriptor once; if still stale, report it and wait for the user. |
| `host_identity_mismatch` | The PID, creation time, or listening socket no longer match the descriptor. | Another Host owns that origin. Do not send the token; report and stop. |
| `auth_required` | This connection generation's cookie was rejected. | The generation is dead: reconnect once, then report. |
| `auth_rejected` | The launch token was refused or the exchange returned no cookie. | Do not retry with another scheme and never fall back to an unauthenticated request. Report it. |
| `unsupported_host_version` | The installed Desktop speaks a protocol family this build does not implement. | Install a build that matches that Desktop release. Do not improvise a transport. |
| `protocol_mismatch` | A response did not match the documented envelope, or answered a different `rpcId`. | Stop; report the method and the mismatch. |
| `capability_unavailable` | The adapter does not provide the capability the action needs. | Tell the user which capability is missing; nothing was sent to the Host. |
| `session_busy` | A session, pending interaction, queue or job is active. | For release, preserve the claim and inspect status; do not enqueue a follow-up just to clear this error. |
| `workspace_state_unknown` | Fresh inbox/jobs/lineage evidence is missing, malformed or unavailable. | Preserve the claim and report the missing evidence. Desktop 0.2.1-rc.2 supports live reads; a normal status's unknown mux queue is not itself a release failure. No force bypass. |
| `ambiguous_wait_target` / `unverified_wait_target` | The observed run cannot be uniquely attributed to the queued bridge prompt. | Inspect history and result ownership; do not resend a possibly accepted prompt. |
| `observation_timeout` | Initial synchronization exceeded the observation deadline. | Check connection and resume observation; this does not mean DSH was canceled. |
| `workspace_conflict` | Another task claims an overlapping directory. | Use a disjoint directory or worktree, or finish and release the other task first. |
| `write_outcome_unknown` | A write was sent but no result came back and the history cannot prove it landed. | Do **not** resend. Inspect the session with `dsh_status`/`dsh_tail` first. |
| `content_unavailable` | The protocol does not expose the body the caller asked for. | Say it is unknown; never invent content. |
