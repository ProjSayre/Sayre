// Standalone process running the Jira ticket poll loop (see jiraPoller.ts for
// why polling, not a Jira-side webhook). Kept as its own entrypoint/script
// (mirrors `worker:tickets` running `worker.ts` as its own process) rather
// than folded into worker.ts's module body, so importing worker.ts (e.g. from
// worker.test.ts) never has the side effect of starting a real interval.

import { runJiraPollCycle } from './jiraPoller';

const POLL_INTERVAL_MS = Number(process.env.JIRA_POLL_INTERVAL_MS ?? 60_000);

async function tick(): Promise<void> {
  try {
    const result = await runJiraPollCycle();
    // eslint-disable-next-line no-console
    console.log('[jira-poll]', JSON.stringify(result));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[jira-poll] cycle failed:', error);
  }
}

void tick();
setInterval(() => {
  void tick();
}, POLL_INTERVAL_MS);
