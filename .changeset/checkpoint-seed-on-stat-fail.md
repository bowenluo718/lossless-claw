---
"@martian-engineering/lossless-claw": patch
---

Seed a placeholder `conversation_bootstrap_state` row in the afterTurn slow-path stat-fail branch so the next turn can recover.

`#649` added a stat-fail fallback that returns `hasOverlap:true` to permit live `afterTurn` persistence even when `stat(sessionFile)` fails, expecting the subsequent `refreshAfterTurnBootstrapState` hook to refresh the checkpoint. That hook calls `refreshBootstrapState`, which independently calls `stat(sessionFile)` and throws on failure, so the catch block in the hook swallows the error and `conversation_bootstrap_state` stays `NULL`. Every subsequent `afterTurn` then re-enters the slow path with `reason="checkpoint-missing"`, which is intentionally excluded from `allowNoAnchorImport`, and the conversation gets stuck: LCM degrades into a transparent passthrough where the assemble safe-fallback returns `params.messages` verbatim and compaction never runs.

This restores the contract that "permissive return ⟹ checkpoint exists" without re-introducing the unconditional refresh `#649` deliberately removed. The placeholder is written via `summaryStore.upsertConversationBootstrapState` directly so it does not depend on stat success. Subsequent turns recover from offset=0 once the transcript becomes statable, but route that placeholder recovery through the existing DB-anchor reconciliation path so already-persisted live afterTurn messages are not replayed as new rows.
