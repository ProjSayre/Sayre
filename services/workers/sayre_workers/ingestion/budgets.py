"""Named structural-sync budget for W1-05's Acceptance sentence.

The 15-second figure previously existed only as prose in
services/core/src/services/providerSettingsService.ts:48 ("...never the 15-second
structural-sync target") and in .claude/rules/async-messaging.md. This is the single
Python-side binding of that number, so a test can assert against a constant rather
than a magic literal.
"""

from __future__ import annotations

STRUCTURAL_SYNC_TARGET_MS: int = 15_000
