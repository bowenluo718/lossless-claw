---
"@martian-engineering/lossless-claw": patch
---

Prevent `afterTurn` replay batches from duplicating messages whose stored content was rewritten during ingest, such as large-file payload references.
