import { describe, it, expect } from 'vitest';
import { Lifecycle } from '../src/gateway/lifecycle.js';
import { Inbox } from '../src/gateway/inbox.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('gateway restart safety', () => {
  it('keeps claimed work active through delivery and acknowledgement while draining', async () => {
    const lifecycle = new Lifecycle();
    let finish!: () => void;
    const pending = lifecycle.run(() => new Promise<void>(resolve => { finish = resolve; }));
    lifecycle.drain();
    expect(lifecycle.draining).toBe(true);
    expect(lifecycle.active).toBe(1);
    finish(); await pending;
    expect(lifecycle.active).toBe(0);
  });
  it('releases active tracking on failure', async () => {
    const lifecycle = new Lifecycle();
    await expect(lifecycle.run(async () => { throw new Error('delivery failed'); })).rejects.toThrow();
    expect(lifecycle.active).toBe(0);
  });
  it('recovers pending messages and suppresses completed replay after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'su-inbox-'));
    try {
      const path = join(directory, 'inbox.json');
      const first = new Inbox(path);
      first.add('channel', 'message');
      const recovered = new Inbox(path);
      expect(recovered.items()).toEqual([{ channelId: 'channel', messageId: 'message' }]);
      recovered.remove('message');
      const restarted = new Inbox(path);
      restarted.add('channel', 'message');
      expect(restarted.size).toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
