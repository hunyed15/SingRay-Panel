// 轻量调度器:注册式任务 + 30s tick,防重叠执行。进程内运行,重启即清(任务自身幂等)。

export interface SchedulerJob {
  name: string;
  intervalMs: number;
  run: () => Promise<string | void>;
  lastOk?: boolean;
  lastAt?: number;
  lastDetail?: string;
  running?: boolean;
  nextAt: number;
}

const jobs = new Map<string, SchedulerJob>();
let timer: NodeJS.Timeout | null = null;

export function registerJob(name: string, intervalMs: number, run: () => Promise<string | void>): void {
  jobs.set(name, { name, intervalMs, run, nextAt: 0 }); // nextAt=0 → 首个 tick 立即跑一次
}

async function tick(): Promise<void> {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.running || now < job.nextAt) continue;
    job.running = true;
    job.nextAt = now + job.intervalMs;
    void (async () => {
      try {
        const detail = await job.run();
        job.lastOk = true;
        job.lastAt = Date.now();
        job.lastDetail = typeof detail === 'string' ? detail : '';
      } catch (err) {
        job.lastOk = false;
        job.lastAt = Date.now();
        job.lastDetail = (err as Error).message.slice(0, 300);
      } finally {
        job.running = false;
      }
    })();
  }
}

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), 30_000);
  timer.unref?.();
  void tick();
}

export function jobStatus(): { name: string; intervalMs: number; lastOk: boolean | null; lastAt: number | null; lastDetail: string; nextInSec: number | null }[] {
  const now = Date.now();
  return [...jobs.values()].map((j) => ({
    name: j.name,
    intervalMs: j.intervalMs,
    lastOk: j.lastOk ?? null,
    lastAt: j.lastAt ?? null,
    lastDetail: j.lastDetail ?? '',
    nextInSec: j.nextAt ? Math.max(0, Math.round((j.nextAt - now) / 1000)) : null,
  }));
}

/** 测试用:手动触发一次 tick(等待所有任务落定) */
export async function tickNow(): Promise<void> {
  await tick();
  // 等待所有 running 任务完成
  for (let i = 0; i < 50; i++) {
    if (![...jobs.values()].some((j) => j.running)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function resetScheduler(): void {
  jobs.clear();
  if (timer) clearInterval(timer);
  timer = null;
}
