// 告警通道:Telegram Bot 推送(TG_BOT_TOKEN/TG_CHAT_ID 未配置时降级为仅落库)。
// 所有告警同时写入 job_runs(job='alert'),运维状态页可回溯。

import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

export async function sendAlert(db: DatabaseSync, title: string, detail = ''): Promise<{ delivered: boolean }> {
  db.prepare("INSERT INTO job_runs (job, ok, detail) VALUES ('alert', 1, ?)").run(
    detail ? `${title} — ${detail}` : title,
  );
  pruneRuns(db);

  if (!config.tgBotToken || !config.tgChatId) return { delivered: false };
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.tgChatId, text: detail ? `${title}\n${detail}` : title }),
      signal: AbortSignal.timeout(10_000),
    });
    return { delivered: res.ok };
  } catch {
    return { delivered: false }; // TG 网络不通(墙内)不阻断主流程,记录即可
  }
}

/** 保留最近 500 条运行记录 */
export function pruneRuns(db: DatabaseSync): void {
  db.prepare(
    'DELETE FROM job_runs WHERE id NOT IN (SELECT id FROM job_runs ORDER BY id DESC LIMIT 500)',
  ).run();
}

export function recordRun(db: DatabaseSync, job: string, ok: boolean, detail = ''): void {
  db.prepare('INSERT INTO job_runs (job, ok, detail) VALUES (?, ?, ?)').run(job, ok ? 1 : 0, detail.slice(0, 500));
  pruneRuns(db);
}
