import { describe, it, expect, beforeEach } from 'vitest';
import { withServerLock, holdsServerLock, resetServerLocks } from './locks.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('per-server lock', () => {
  beforeEach(() => resetServerLocks());

  it('同一台机器的操作串行执行', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const a = withServerLock(1, async () => {
      order.push('a:start');
      await gate;
      order.push('a:end');
    });
    const b = withServerLock(1, async () => {
      order.push('b:start');
    });

    await tick();
    expect(order).toEqual(['a:start']); // b 还在排队
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('不同机器并行,互不阻塞', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = withServerLock(1, async () => {
      await gate;
      order.push('a');
    });
    const b = withServerLock(2, async () => {
      order.push('b');
    });
    await b; // 机器 1 还卡着,机器 2 已经完成
    expect(order).toEqual(['b']);
    release();
    await a;
    expect(order).toEqual(['b', 'a']);
  });

  it('同异步链内嵌套调用复用外层锁(部署 → 自动安装核心),不会自锁死', async () => {
    const r = await withServerLock(1, async () => {
      expect(holdsServerLock(1)).toBe(true);
      return withServerLock(1, async () => 'nested-ok');
    });
    expect(r).toBe('nested-ok');
    expect(holdsServerLock(1)).toBe(false);
  });

  it('排队超时抛 409,且不会在超时后偷偷执行', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let ranLate = false;
    const a = withServerLock(1, async () => {
      await gate;
    });
    const b = withServerLock(
      1,
      async () => {
        ranLate = true;
        return 'late';
      },
      { waitMs: 20 },
    );
    await expect(b).rejects.toThrow(/正在执行其他操作/);
    release();
    await a;
    await tick();
    expect(ranLate).toBe(false);
  });

  it('前一个操作抛错不影响后续操作', async () => {
    await expect(
      withServerLock(2, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(withServerLock(2, async () => 'ok')).resolves.toBe('ok');
  });
});
