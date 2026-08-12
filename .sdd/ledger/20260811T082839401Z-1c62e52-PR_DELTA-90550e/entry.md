# Ledger entry — 20260811T082839401Z-1c62e52-PR_DELTA-90550e (RE-GATE)

## Date
2026-08-11

## Ticket
CH-06

CH-06 — Ask Sayre panel UI

## Spec Goal
Turn the reserved inert AskSayre dock into a real, collapsible right-hand Ask Sayre chat panel mounted across the Technical, Product, and Onboarding views: it auto-attaches the current view + selected node as scope, posts questions through the existing core proxy to CH-03's chat routes, renders live progress and markdown answers driven by CH-05's pinned chat.turn.* WebSocket events, and lets a citation chip select and zoom the cited Folder/File node on the canvas. The entire diff is confined to apps/web/.

## Files touched
- apps/web/app/workspace/chat/AskSayrePanel.test.tsx
- apps/web/app/workspace/chat/ChatProvider.tsx
- apps/web/app/workspace/chat/chatAckContract.test.tsx

## Verdicts
- review: PASS
- security: PASS

## Re-gate
This run's review/security verdicts were produced by re-running the gates against a tree that was hand-edited directly, outside `dev`'s own re-invocation loop, after `changes.md`/`changes.json` were written for this ticket — see `.sdd/pipeline.md`'s `/re-gate` section. `changes.md`/`changes.json` describe the tree as it stood **before** that hand-edit, not as it stands now. `tester` was re-run against the hand-edited tree on this pass.

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- apps/web/app/workspace/chat/chatContract.test.ts
- apps/web/app/workspace/chat/answerMarkdown.test.ts
- apps/web/app/workspace/chat/citationTarget.test.ts
- apps/web/app/workspace/chat/chatClient.test.ts
- apps/web/app/workspace/chat/chatTranscript.test.ts
- apps/web/app/workspace/chat/chatSafetyGuards.test.ts
- apps/web/app/workspace/chat/AskSayrePanel.test.tsx
- apps/web/app/workspace/askSayreRegistry.test.ts

## Security run ID
.pipeline/security-history/20260811T082839401Z-1c62e52-PR_DELTA-90550e/

## Commit
1c62e52fc483d1d8ecfcaf4abd45a101fe3b9ee4 (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)
