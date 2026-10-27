/** 1.2.5 — la file respecte le compte à rebours annoncé et le réarme par alarme (pas de setInterval). */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

const mem: Record<string, unknown> = {};
const alarms: Array<{ name: string; when?: number }> = [];
const cleared: string[] = [];
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (k: string | string[]) => {
        const keys = Array.isArray(k) ? k : [k];
        return Object.fromEntries(keys.filter((x) => x in mem).map((x) => [x, structuredClone(mem[x])]));
      },
      set: async (o: Record<string, unknown>) => void Object.assign(mem, structuredClone(o)),
    },
  },
  alarms: {
    create: async (name: string, o: { when?: number }) => void alarms.push({ name, when: o.when }),
    clear: async (name: string) => void cleared.push(name),
  },
};

const { processNext, pauseQueue, alarmNameNext } = await import('../src/application/queueRunner.ts');
const { initialRunState } = await import('../src/domain/queue.ts');

after(async () => {
  await pauseQueue(); // annule le minuteur en attente
});

describe('queue runner — announced wait', () => {
  it('does not act before nextActionAt and arms a one-shot alarm', async () => {
    const next = Date.now() + 40_000;
    mem.run = { ...initialRunState(), running: true, nextActionAt: next, lastActionAt: Date.now() - 5_000 };
    mem.queue = [{ key: 'h:a', handle: 'a', action: 'block', addedAt: 0, attempts: 0 }];
    await processNext();
    assert.equal((mem.queue as unknown[]).length, 1, 'nothing processed during the wait');
    const a = alarms.find((x) => x.name === alarmNameNext());
    assert.ok(a, 'one-shot alarm created');
    assert.ok(Math.abs((a!.when ?? 0) - next) < 2_000);
  });
  it('manual pause clears the countdown and the alarm', async () => {
    await pauseQueue();
    assert.equal((mem.run as { nextActionAt: unknown }).nextActionAt, null);
    assert.ok(cleared.includes(alarmNameNext()));
  });
});
