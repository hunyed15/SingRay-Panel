// 告警通道:Telegram Bot 推送(TG_BOT_TOKEN/TG_CHAT_ID 未配置时降级为仅落库)。
// 所有告警同时写入 job_runs(job='alert'),运维状态页可回溯。

import type { DatabaseSync } from 'node:sqlite';
import { resolveTgConfig } from '../services/settings.js';

export async function sendAlert(db: DatabaseSync, title: string, detail = ''): Promise<{ delivered: boolean }> {
  db.prepare("INSERT INTO job_runs (job, ok, detail) VALUES ('alert', 1, ?)").run(
    detail ? `${title} — ${detail}` : title,
  );
  pruneRuns(db);

  const tg = resolveTgConfig(db);
  if (!tg.botToken || !tg.chatId) return { delivered: false };
  try {
    const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: tg.chatId, text: detail ? `${title}\n${detail}` : title }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // 送达失败必须留痕:旧实现无论成败都写 ok=1,运维卡片永远绿的
      const body = await res.text().catch(() => '');
      recordRun(db, 'alert-error', false, `Telegram ${res.status}:${body.slice(0, 200)}`);
      return { delivered: false };
    }
    return { delivered: true };
  } catch (err) {
    recordRun(db, 'alert-error', false, (err as Error).message); // TG 网络不通(墙内)不阻断主流程
    return { delivered: false };
  }
}

/** 清理运行记录:保留 7 天,且最多 2000 条(健康检查+流量每天约 576 条,500 条不到一天) */
export function pruneRuns(db: DatabaseSync): void {
  db.prepare("DELETE FROM job_runs WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')").run();
  db.prepare('DELETE FROM job_runs WHERE id NOT IN (SELECT id FROM job_runs ORDER BY id DESC LIMIT 2000)').run();
}

export function recordRun(db: DatabaseSync, job: string, ok: boolean, detail = ''): void {
  db.prepare('INSERT INTO job_runs (job, ok, detail) VALUES (?, ?, ?)').run(job, ok ? 1 : 0, detail.slice(0, 500));
  pruneRuns(db);
}
