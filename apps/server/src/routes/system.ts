// 系统运维路由:调度器状态 / 备份列表与手动备份 / 手动健康检查
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { jobStatus } from '../core/scheduler.js';
import { listBackups, runBackupNow } from '../core/backup.js';
import { runHealthCheckCycle } from '../core/healthcheck.js';
import { config } from '../config.js';

export default async function systemRoutes(app: FastifyInstance): Promise<void> {
  /** 调度器状态 + 备份清单 + TG 配置状态(设置页运维卡片) */
  app.get('/status', async () => ({
    jobs: jobStatus(),
    backups: listBackups(),
    tgConfigured: Boolean(config.tgBotToken && config.tgChatId),
    healthIntervalMin: config.healthIntervalMin,
    backupRetention: config.backupRetention,
  }));

  /** 立即备份 */
  app.post('/backup', async () => {
    const r = runBackupNow(getDb());
    return { ok: true, file: r.file, size: r.size };
  });

  /** 立即执行一轮健康检查 */
  app.post('/healthcheck', async () => {
    const summary = await runHealthCheckCycle(getDb());
    return { ok: true, summary };
  });
}
