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
      expect(recovered.items()).toEqual([{
        channelId: 'channel', messageId: 'message', attempts: 0, nextAttemptAt: 0,
      }]);
      recovered.remove('message');
      const restarted = new Inbox(path);
      restarted.add('channel', 'message');
      expect(restarted.size).toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('persists deferred delivery state and dead letters without marking the message completed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'su-inbox-deferred-'));
    try {
      const path = join(directory, 'inbox.json');
      const first = new Inbox(path);
      first.add('channel', 'message');
      first.recordToolReceipt('message', 'post:abc', { posted: true, messageId: 'sent' });
      first.defer('message', { delayMs: 60_000, noticeMessageId: 'notice', error: 'timeout' });
      expect(first.size).toBe(1);
      expect(first.items()).toEqual([]);

      const recovered = new Inbox(path);
      expect(recovered.items(Number.MAX_SAFE_INTEGER)[0]).toMatchObject({
        messageId: 'message', attempts: 1, noticeMessageId: 'notice', lastError: 'timeout',
      });
      expect(recovered.toolReceipt('message', 'post:abc')).toEqual({
        found: true, value: { posted: true, messageId: 'sent' },
      });
      recovered.fail('message', 'still unavailable');
      expect(recovered.size).toBe(0);
      expect(recovered.deadLetterSize).toBe(1);
      expect(recovered.requeueDeadLetters()).toBe(1);
      expect(recovered.items()).toHaveLength(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
