import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET /api/health', () => {
  it('returns a 200 HealthStatus payload for the web service', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('web');
    expect(typeof body.version).toBe('string');
    expect(typeof body.timestamp).toBe('string');
  });

  it('is dynamic — consecutive calls return different timestamps', async () => {
    const first = await GET().json();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await GET().json();
    expect(first.timestamp).not.toBe(second.timestamp);
  });
});
