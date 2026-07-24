export class McpRateLimitError extends Error {
  constructor() {
    super('MCP rate limit exceeded.');
    this.name = 'McpRateLimitError';
  }
}

export interface McpRateLimiter {
  consume(
    orgId: string,
    keyPrefix: string,
    limitPerMinute: number,
  ): void;
}

interface WindowState {
  startedAt: number;
  count: number;
}

export class InMemoryMcpRateLimiter implements McpRateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(
    orgId: string,
    keyPrefix: string,
    limitPerMinute: number,
  ): void {
    if (
      !Number.isSafeInteger(limitPerMinute) ||
      limitPerMinute < 1 ||
      limitPerMinute > 10_000
    ) {
      throw new McpRateLimitError();
    }
    const key = `${orgId}:${keyPrefix}`;
    const now = this.now();
    const current = this.windows.get(key);
    const state =
      current === undefined || now - current.startedAt >= 60_000
        ? { startedAt: now, count: 0 }
        : current;
    if (state.count >= limitPerMinute) throw new McpRateLimitError();
    state.count += 1;
    this.windows.set(key, state);

    // Bound process memory without adding a timer that could keep tests or
    // graceful shutdown alive.
    if (this.windows.size > 10_000) {
      for (const [entryKey, entry] of this.windows) {
        if (now - entry.startedAt >= 60_000) this.windows.delete(entryKey);
      }
    }
  }
}

export const mcpRateLimiter: McpRateLimiter = new InMemoryMcpRateLimiter();
