## Review correction superseding the original partial-write disposition

The historical `receipt.json` below remains unchanged. Its wall-first partial-write limitation and WallClient ignore-false audit are superseded by implementation `67e4e1e43cab9b9c3f14fb24a75120ce12e7dced`; see [review-followup.json](review-followup.json). APP-WALL-REVIEW-001/002/003 were reproduced and repaired, pending independent exact-head re-review.

Cross-key remove/re-create operations first reserve validated before/after bytes in `ticketstub.wall.mutation.v1`. Reservation failure changes neither primary key. A subsequent failure compensates exact original bytes; if compensation fails, durable preparation makes wall, deletion, generation reads and sync unknown rather than publishing a contradictory row/tombstone pair. Recovery refuses differing peer bytes. Only failed preparations can be recovered by later readers; an observed in-flight preparation stays blocked and requires owner-directed resolution if its owner cannot classify/compensate it. This is not a multi-key transaction or cross-process fence. Preparation needs extra storage capacity; ordinary single-key quota release remains limited to oldest unselected inline art, retaining selected art, identity/seed and same-version art.

Actual in-memory SQLite deletion-wins tests cover failed re-create/delete followed by sync, successful retry, failures at preparation/wall/deletion/marker cleanup/compensation, new reader recovery, peer divergence and status-reminder failure. The exact e59 candidate fails 8 of 11 recovery tests; corrected bytes pass all 11. Focused tests pass 251; full units pass 1,052 with one default PostgreSQL skip. Build, typecheck and lint pass (existing fixture warning only). Native offline browser checks pass 18 child/20 wrapper assertions, including malformed deletion-state wording and failed-delete card retention, accessible retry and keyboard recovery. No live account/provider calls occurred.

The WallClient now retains its card and lift on failed removal and announces an actionable retry. Account wording covers saved data/deletion state accurately. Remote acknowledgement remains distinct from local persistence; no remote rollback is claimed. Acknowledged tombstone cleanup failures retain queued intent without a false successful sync event. Other legacy callers are unchanged.

Historical e59 hosted runtime and order-gate passes do not qualify this correction. New hosted checks and landing_candidate_review must inspect the newly published exact head. Product peer policy, canonical app-owned assembly/owner-run acceptance, unavailable historical 200% text measurements and manual GoDaddy publication isolation remain unresolved/outside this patch. No deployment, merge or issue closure occurred.

---

# Wall write integrity continuation

Refs: #10, #97, #98. Isolated branch `fix/wall-write-integrity-20261015`, worktree `/tmp/gt-wall-write-continuation-20261015`. Exact published base: PR211 `872a5c644b624d7f55fbdaf9fb48c06e2c816a92` on `fix/generation-state-observation-20261015`. Implementation: `b02de50233215355d5e915d73fcb463be3687eed`. This branch does not merge/cherry-pick or push the original PR100/124/209/210/211 refs. The original checkout remains clean at `c7a0f5fae5bc56cefc251e1c95aabd7e119a1f34`.

## Executed findings and repair

The regression file was first run with the exact base implementation: **42 failed / 5 passed**. It reproduced malformed JSON being replaced during removal, malformed peer rows/history reaching retention, deletion/status side effects preceding refusal, read-throws/write-works danger, sync sending unreadable local data, and remote acknowledgement being reported as local success after a failed write. That failed log remains retained; it is not counted as success.

The new typed `readWall` distinguishes known data from unknown. Only `getItem` null represents first use; `[]` is known empty. Exceptions, empty strings, malformed/non-array JSON and malformed rows/history are unknown. Validation reuses `readableGenerationHistory` for every row/version and checks the local event/personal/photo/update fields consumed by client reads and merge. Optional missing legacy photos remain supported. It does not normalize/filter rows, rewrite facts, change enum/schema/SDK contracts or discard unknown extension fields. The existing share `isStub` is only a shallow projection guard; server `readStub` externalizes art and drops photos, so neither is a suitable local mutation validator.

All wall write APIs retain their synchronous boolean contracts and `writeWallDetailed` retains `{ok,released}`. They require a valid current read and readable candidate before retention/writing. Unknown bytes are preserved exactly. `upsertStub` and `removeStub` read the wall and deletion queue before mutation, write the wall before modifying tombstones, and do not advertise `WALL_CHANGED` or forget generation status on a refused/failed wall write. Successful same-ID recreation still clears its tombstone. Status is forgotten only after the wall and deletion queue writes succeed. Quota retention remains unchanged: oldest unselected inline images only, preserving selected art, IDs, seed and same-version art recovery.

Sync refuses unreadable wall/deletion state before any remote request. After a validated reply it preserves server acknowledgement separately (`remoteAcknowledged`, `isOnServer`), then fresh-reads/folds local data, checks `writeWall` and deletion-queue persistence, and only emits `WALL_SYNCED`/`server_save:saved` after local success. Failure reports `localReadFailed` or `localPersistenceFailed`; the open editor draft is not replaced and a successful remote acknowledgement is not described as rolled back. Only the acknowledged request's deletion-ID snapshot is cleared after safe local handling; new IDs queued during the await remain. Local photos and same-version art are retained.

## Caller audit

| Caller/boundary | Actual disposition |
| --- | --- |
| `writeWall` / `writeWallDetailed` / `saveWall` | Same synchronous API; false for unknown reads or invalid candidates. Only successful `saveWall` emits `WALL_CHANGED`. Sync continues to call `writeWall`, with no change echo. |
| `upsertStub`; Editor, TearFlow, start/make and WallClient edits | Safe read before retain/merge; false remains the unsaved indicator where callers use it. Existing intentionally optimistic/ignored-false behavior is not converted into a UI rollback. |
| `removeStub`; WallClient.remove | Failed wall write queues no tombstone and forgets no status. WallClient still intentionally removes its in-memory card even if false and reports failure telemetry; this patch does not claim visual rollback. |
| WallClient initial placement / `saveWall` | May still ignore false, but an unknown wall can no longer authorize destructive storage replacement or a confirmed change event. |
| `recordCorrection` / `undoStubCorrection` | Existing return-the-memory-draft API retained; their underlying upsert now refuses unreadable storage. These helpers are not a durability receipt. |
| `loadWall` display readers: WallClient, AccountLine, nav routes, start/make; `getStub` | Array API preserved as a read-only fallback. An unreadable wall is never authority for a mutation or sync. Presence/removal decisions use typed presence instead. |
| `stubPresence`, `wallPresenceFromValue`, `readStoredStub` | Reuse the typed wall parser. Unknown peers are not proof of removal. Generation's existing narrow storage snapshot/controller and merge policy are otherwise unchanged. |
| `loadDeleted` / `readDeleted` / `saveDeleted` | Legacy array/boolean APIs retained. Mutation and sync use typed reads, refusing unknown tombstone bytes before queue changes. |
| `syncNow` / scheduled focus/change | One validated snapshot sent; a fresh read after await protects in-flight edits under the existing fold policy. Result event carries failures even when scheduled callers discard the promise. Preview saving-off retains its existing no-sync behavior, with unknown read failure instead of false empty success. |
| `AccountRoot` | Sign-in return uses `ok`; ordinary signed-in mount/focus/change also receive result events. Local failures have persistent, announced explanation and keyboard retry, distinct from generic network failure; success clears the warning. |
| `isOnServer` -> Editor | Still means a server reply acknowledged this visit; it only gates correction/version event reporting. It is not local persistence proof, byte equivalence or an authenticated generation fence. It remains true after real acknowledgement even if the local write fails. |
| `WALL_SYNCED` -> Editor, VersionsPanel, WallClient | Refresh/reconciliation occurs only after actual local wall/queue handling succeeds. A forged DOM event remains neither artwork identity nor canonical authority. |

## Actual validation

Node 22.23.3 / npm 11.16.0, local dependency install from the lockfile. [Receipt](receipt.json) records exact source/input/log digests and test commands.

- Focused wall/generation/recovery/status/retention/analytics: **240 passed, 0 failed, 0 skipped**.
- Full units: **1041 passed, 0 failed, 1 default SQL skip**. Separate required pinned-PostgreSQL creative-host check: **5 passed, 0 failed, 0 skipped**, intercepted provider transport.
- Production build, typecheck and lint: exit 0; only the pre-existing fixture `$comment` warning.
- New network-blocked `wall-integrity` browser suite: **11 child / 13 wrapper passed**, 0 failed/skipped/outbound attempts. Production React with explicitly synthetic auth/sync verifies ordinary mount, warning persistence, keyboard retry, focus/change failure and recovery, 320px layout, unknown-wall refusal and unchanged bytes. It makes no live account/provider call. Added to runtime CI.
- The first browser harness attempt failed because a global lexical `fetch` binding bypassed its interceptor. Corrected harness; failed log/receipt retained separately. It is not an application acceptance failure or a passing check.

## Retained limits and next owner

This is not a transaction, Web Lock, cross-process CAS, server incarnation/deletion fence or Product peer-edit merge election. Another tab/process can still interleave between synchronous reads/writes. Multi-key operations are not atomic: a wall write may succeed before a later deletion-queue write fails; false means incomplete handling, not rollback. Quota retry writes are likewise not a rollback protocol. No stronger deletion/restore or peer-history guarantee is claimed. Product's separately gated non-version peer edit/merge policy and client/server fence choice remain open.

The historical 200-percent text failure has unavailable raw measurements and is outside this repair; no measurement, repair, waiver or zoom/screen-reader qualification is invented. The focused browser check is not that historical qualification. No broad #10/#97/#98 acceptance or closure is claimed. Independent `landing_candidate_review` review of the exact candidate, required hosted checks and supervisor-owned merge/post-merge evidence remain necessary. Only integration-evals owns canonical master acceptance and requires the real app-owned pinned assembly and exact owner-run evidence.

No deployment, provider spend, credential change, original-branch merge, force push or issue closure. Any separately authorized future GoDaddy publication still requires the manual two-save Preview analytics restore and fresh-session isolation check; this branch does not authorize publication.
