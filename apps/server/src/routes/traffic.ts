// 流量与 Dashboard 路由
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { todaySummary, collectAllTraffic } from '../core/traffic.js';
import { listPendingDeploys } from '../services/deployState.js';
import { jobStatus } from '../core/scheduler.js';
import { config } from '../config.js';

export default async function trafficRoutes(app: FastifyInstance): Promise<void> {
  /** 今日流量(按节点 + 汇总) */
  app.get('/summary', async () => todaySummary(getDb()));

  /** 手动触发一轮采集 */
  app.post('/collect', async () => ({ ok: true, summary: await collectAllTraffic(getDb()) }));

  /** Dashboard 聚合(首页一次拉全) */
  app.get('/dashboard', async () => {
    const db = getDb();
    const machines = db.prepare("SELECT id, name, role, ping_status, xray_ping_status FROM servers WHERE control = 'ssh' ORDER BY id").all() as any[];
    const online = machines.filter((m) => m.ping_status === 'online').length;
    const pending = listPendingDeploys(db);
    const traffic = todaySummary(db);
    const alerts = (
      db.prepare("SELECT detail, created_at FROM job_runs WHERE job = 'alert' ORDER BY id DESC LIMIT 10").all() as any[]
    ).map((r) => ({ detail: r.detail, at: r.created_at }));

    // 证书临期(本地无缓存,仅展示上次健康检查写入的未知态——详情见证书管理页)
    return {
      machines: { total: machines.length, online, list: machines.map((m) => ({ id: m.id, name: m.name, role: m.role, ping: m.ping_status, xray: m.xray_ping_status })) },
      pendingDeploys: pending,
      traffic: { date: traffic.date, totalUp: traffic.totalUp, totalDown: traffic.totalDown, top: traffic.nodes.slice(0, 10) },
      alerts,
      scheduler: jobStatus(),
      tgConfigured: Boolean(config.tgBotToken && config.tgChatId),
    };
  });
}
