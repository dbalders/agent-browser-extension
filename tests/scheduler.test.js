import { describe, expect, it } from 'vitest';
import { CommandScheduler } from '../extension/scheduler.js';

describe('scheduler failure isolation', () => {
  it('rejects a failed lazy resource lookup without stranding later work', async () => {
    const scheduler = new CommandScheduler();
    const failed = scheduler.schedule({ resources: () => { throw new Error('Resource lookup failed'); } }, () => 'must not run');
    await expect(failed).rejects.toThrow('Resource lookup failed');
    await expect(scheduler.schedule({ resources: [['tab:1', 'write']] }, () => 'next command')).resolves.toBe('next command');
    expect(scheduler.queue).toHaveLength(0);
  });
});
