import { AnafRateLimiter } from './anaf-rate-limiter';

describe('AnafRateLimiter', () => {
  it('keeps consecutive calls at least one interval apart', async () => {
    const interval = 120;
    const limiter = new AnafRateLimiter(interval);
    const startTimes: number[] = [];

    const task = () => {
      startTimes.push(Date.now());
      return Promise.resolve('ok');
    };

    await Promise.all([limiter.schedule(task), limiter.schedule(task), limiter.schedule(task)]);

    expect(startTimes).toHaveLength(3);
    // A small tolerance for timer jitter; the point is that the gap exists at all.
    expect(startTimes[1] - startTimes[0]).toBeGreaterThanOrEqual(interval - 15);
    expect(startTimes[2] - startTimes[1]).toBeGreaterThanOrEqual(interval - 15);
  });

  it('keeps working after a task rejects', async () => {
    const limiter = new AnafRateLimiter(10);
    await expect(limiter.schedule(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.schedule(() => Promise.resolve('still alive'))).resolves.toBe('still alive');
  });
});
