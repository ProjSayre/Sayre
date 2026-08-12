# Ledger entry — 20260811T045119987Z-6d3acfc-PR_DELTA-e8d162

## Date
2026-08-11

## Ticket
CH-06

CH-06 — Ask Sayre panel UI

## Spec Goal
Turn the reserved inert AskSayre dock into a real, collapsible right-hand Ask Sayre chat panel mounted across the Technical, Product, and Onboarding views: it auto-attaches the current view + selected node as scope, posts questions through the existing core proxy to CH-03's chat routes, renders live progress and markdown answers driven by CH-05's pinned chat.turn.* WebSocket events, and lets a citation chip select and zoom the cited Folder/File node on the canvas. The entire diff is confined to apps/web/.

## Files touched
- apps/web/app/mock/README.md
- apps/web/app/workspace/askSayreRegistry.test.ts
- apps/web/app/workspace/askSayreRegistry.ts
- apps/web/app/workspace/chat/AskSayrePanel.test.tsx
- apps/web/app/workspace/chat/AskSayrePanelBody.tsx
- apps/web/app/workspace/chat/ChatProvider.tsx
- apps/web/app/workspace/chat/ChatTranscriptList.tsx
- apps/web/app/workspace/chat/answerMarkdown.test.ts
- apps/web/app/workspace/chat/answerMarkdown.ts
- apps/web/app/workspace/chat/askSayreRenderers.tsx
- apps/web/app/workspace/chat/chatClient.test.ts
- apps/web/app/workspace/chat/chatClient.ts
- apps/web/app/workspace/chat/chatContract.test.ts
- apps/web/app/workspace/chat/chatContract.ts
- apps/web/app/workspace/chat/chatDegradedRecovery.test.tsx
- apps/web/app/workspace/chat/chatSafetyGuards.test.ts
- apps/web/app/workspace/chat/chatTranscript.test.ts
- apps/web/app/workspace/chat/chatTranscript.ts
- apps/web/app/workspace/chat/citationTarget.test.ts
- apps/web/app/workspace/chat/citationTarget.ts
- apps/web/app/workspace/components/AskSayrePanel.tsx
- apps/web/app/workspace/state/WorkspaceProvider.tsx
- apps/web/app/workspace/views/LegacyWorkspaceView.tsx
- apps/web/app/workspace/workspace.css

## Verdicts
- review: PASS
- security: PASS

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
.pipeline/security-history/20260811T045119987Z-6d3acfc-PR_DELTA-e8d162/

## Commit
6d3acfce2d978ca4177038186e80b9c0ac96abe7 (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)
