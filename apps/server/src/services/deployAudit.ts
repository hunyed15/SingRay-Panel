// 部署审计:每台机器每次部署落一行,进程重启也查得到"上次部署什么时候、成没成"。
import type { DatabaseSync } from 'node:sqlite';

export interface DeployAuditRow {
  id: number;
  serverId: number;
  serverName: string;
  ok: boolean;
  createdAt: string;
  /** singbox / xray 各自的结果(截断后的 JSON) */
  detail: {
    singbox?: { ok: boolean; error?: string; steps?: string[] };
    xray?: { ok: boolean; error?: string; steps?: string[] };
  };
}

interface ResultLike {
  serverId: number;
  serverName: string;
  singbox?: { ok: boolean; error?: string; steps?: string[] };
  xray?: { ok: boolean; error?: string; steps?: string[] };
}

/** 保留最近 500 条且最多 90 天 */
export function pruneDeployAudits(db: DatabaseSync): void {
  db.prepare("DELETE FROM deploy_audits WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')").run();
  db.prepare('DELETE FROM deploy_audits WHERE id NOT IN (SELECT id FROM deploy_audits ORDER BY id DESC LIMIT 500)').run();
}

export function recordDeploy(db: DatabaseSync, r: ResultLike): void {
  const ok = Boolean(r.singbox?.ok) && (!r.xray || r.xray.ok || (r.xray as { skipped?: boolean }).skipped);
  const detail = JSON.stringify({
    singbox: r.singbox ? { ok: r.singbox.ok, error: r.singbox.error, steps: r.singbox.steps } : undefined,
    xray: r.xray ? { ok: r.xray.ok, error: r.xray.error, steps: r.xray.steps } : undefined,
  });
  db.prepare('INSERT INTO deploy_audits (server_id, server_name, ok, detail) VALUES (?, ?, ?, ?)').run(
    r.serverId,
    r.serverName ?? '',
    ok ? 1 : 0,
    detail.slice(0, 4000),
  );
  pruneDeployAudits(db);
}

export function listDeployAudits(db: DatabaseSync, serverId?: number, limit = 50): DeployAuditRow[] {
  const rows = (
    serverId
      ? db
          .prepare('SELECT * FROM deploy_audits WHERE server_id = ? ORDER BY id DESC LIMIT ?')
          .all(serverId, limit)
      : db.prepare('SELECT * FROM deploy_audits ORDER BY id DESC LIMIT ?').all(limit)
  ) as any[];
  return rows.map((r) => {
    let detail: DeployAuditRow['detail'] = {};
    try {
      detail = JSON.parse(r.detail || '{}');
    } catch {
      /* 坏行按空处理,不影响列表 */
    }
    return {
      id: r.id,
      serverId: r.server_id,
      serverName: r.server_name,
      ok: r.ok === 1,
      createdAt: r.created_at,
      detail,
    };
  });
}
