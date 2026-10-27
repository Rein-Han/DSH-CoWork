# Adaptive / long-wait acceptance

Desktop observation policy v3 supports `DSH_WAIT_PROFILE=adaptive` (up to 300s)
or explicit `long` (up to 900s). Caller names do not determine support.

Use `setup-desktop --caller <caller> --scope user --wait-profile adaptive --replace --dry-run`
to review the profile and per-server timeout change. A configured limit is not
native-client acceptance. Verify real 60/120/180/300s waits, critical early events,
user interrupts, parallel calls and exact result retrieval in this client/version.

With a verified adaptive profile, standalone `dsh_wait` uses 60/120/180/300 seconds
based on the current run age. Pass `schedule:adaptive,observationPolicy:supervised`
and retain receipt target/cursor. An explicit shorter timeout allows earlier review.
Do not create a second observer when the client has backgrounded the first; collect
its native result. Progress notifications do not guarantee a longer hard timeout.

The timer-only `scripts/p3-fixture.mjs` tests transport without contacting a model.
Use `scripts/setup-p3-acceptance.mjs` for the temporary fixture setup. Timer acceptance
cannot prove real DSH steer, full result, fresh queue/jobs or workspace release.
Unverified clients/scenarios retain bounded 30-second observation.

After acceptance, apply the reviewed setup plan and reload the client. Roll back
only owned wait fields with `node dist/rollback-wait-profile.js --caller <caller>
--profile adaptive --backup <installer-backup>` (dry-run; add --apply to write).
A later profile/timeout edit and other settings are preserved. Detailed semantics,
limitations and commands are in the repository's `docs/adaptive-wait.md`.
