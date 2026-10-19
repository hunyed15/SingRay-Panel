// 按机器的互斥锁:同一台机器上的部署 / 安装 / 重启 / 卸载 / 配置下发 / 健康检查串行执行。
//
// 为什么需要:这些操作都在改同一台机器的 /etc/*/config.json、systemd unit 与 iptables,
// 并发执行会出现"两个部署各自 render → swap,后写的赢",或健康检查在 swap 与 restart
// 之间取到半成品状态并误报告警。
//
// shortcut: 进程内锁,只对单实例面板有效;多副本部署需要换成 DB/Redis 锁。
//
// 同一异步链里的嵌套调用(部署 → 自动安装核心)直接复用外层锁:不排队,也不会自锁死。

import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError } from './errors.js';

/** 每个机器 id 一条等待链(上一个操作结束后才轮到下一个) */
const chains = new Map<number, Promise<unknown>>();
const held = new AsyncLocalStorage<ReadonlySet<number>>();

const DEFAULT_WAIT_MS = 10 * 60_000;

export interface ServerLockOptions {
  /** 排队等待上限;超时抛 409,而不是把请求无限挂住 */
  waitMs?: number;
}

export function withServerLock<T>(
  serverId: number,
  fn: () => Promise<T>,
  opts: ServerLockOptions = {},
): Promise<T> {
  const outer = held.getStore();
  if (outer?.has(serverId)) return fn(); // 可重入:已在同一台机器的锁内

  const scope = new Set(outer ?? []);
  scope.add(serverId);

  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const prev = chains.get(serverId) ?? Promise.resolve();

  // 排队超时:超时的调用直接 409,不再在队列里等(也绝不在超时后偷偷执行 fn)
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new HttpError(409, `机器 #${serverId} 正在执行其他操作,请稍后重试`));
    }, waitMs);
    timer.unref?.();
  });

  const run = Promise.race([
    prev.then(() => (expired ? (undefined as never) : held.run(scope, fn))),
    timeout,
  ]);
  void run.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );

  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(serverId, tail);
  void tail.then(() => {
    if (chains.get(serverId) === tail) chains.delete(serverId); // 队列排空即清理
  });
  return run;
}

/** 当前是否已持有该机器的锁(诊断/测试用) */
export function holdsServerLock(serverId: number): boolean {
  return held.getStore()?.has(serverId) ?? false;
}

/** 测试用:清空等待链 */
export function resetServerLocks(): void {
  chains.clear();
}
