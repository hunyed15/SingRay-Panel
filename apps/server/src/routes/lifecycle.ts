// 核心生命周期路由(安装/重启/卸载),挂载在 /api/servers 下,与 CRUD 插件并存。
// 路径与旧版一致: /:id/install|restart|uninstall(sing-box)、/:id/xray-install|xray-restart|xray-uninstall
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { serverLifecycle } from '../services/lifecycle.js';
import { batchCreateNodes } from '../services/batchNodes.js';
import { certStatus, issueCert, hasRealCert } from '../core/certs/acme.js';
import { serverConn } from '../services/conn.js';
import { decrypt } from '../core/crypto.js';
import { config } from '../config.js';

const idParam = z.object({ id: z.coerce.number().int() });
const actionParam = z.object({ id: z.coerce.number().int(), action: z.enum(['install', 'restart', 'uninstall']) });

export default async function lifecycleRoutes(app: FastifyInstance): Promise<void> {
  const run = async (id: number, core: 'singbox' | 'xray', action: 'install' | 'restart' | 'uninstall') => {
    try {
      return await serverLifecycle(getDb(), id, core, action);
    } catch (err) {
      // 与旧版一致:生命周期失败以 {ok:false,error} 返回,前端按结果渲染
      return { ok: false as const, error: (err as Error).message };
    }
  };

  app.post('/:id/install', async (req) => {
    const { id } = idParam.parse(req.params);
    return run(id, 'singbox', 'install');
  });
  app.post('/:id/restart', async (req) => {
    const { id } = idParam.parse(req.params);
    return run(id, 'singbox', 'restart');
  });
  app.post('/:id/uninstall', async (req) => {
    const { id } = idParam.parse(req.params);
    return run(id, 'singbox', 'uninstall');
  });
  app.post('/:id/xray-install', async (req) => {
    const { id } = idParam.parse(req.params);
    return run(id, 'xray', 'install');
  });
  app.post('/:id/xray-restart', async (req) => {
    const { id } = idParam.parse(req.params);
    return run(id, 'xray', 'restart');
  });
  app.post('/:id/xray-uninstall', async (req) => {
    const { id } = idParam.parse(req.params);
    return run(id, 'xray', 'uninstall');
  });
  /** 全机器证书状态聚合(证书管理页用) */
  app.get('/certs', async () => {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM servers WHERE control = 'ssh' ORDER BY id").all() as any[];
    const results = await Promise.all(
      rows.map(async (row) => {
        const domain = row.client_host || row.host;
        try {
          const conn = serverConn(db, row.id);
          const st = await certStatus(conn, domain);
          return { serverId: row.id, name: row.name, ...st, reachable: true }; // st 已含 domain
        } catch (err) {
          return { serverId: row.id, name: row.name, domain, acmeInstalled: false, certExists: false, expiresAt: null, reachable: false, error: (err as Error).message.slice(0, 120) };
        }
      }),
    );
    return results;
  });

  /** 证书状态(acme.sh 是否安装 / 域名证书是否存在/到期时间) */
  app.get('/:id/cert-status', async (req) => {
    const { id } = idParam.parse(req.params);
    const row = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(id) as any;
    if (!row) throw Object.assign(new Error('服务器不存在'), { statusCode: 404 });
    const domain = row.client_host || row.host;
    const conn = serverConn(getDb(), id);
    const [st, supported] = await Promise.all([certStatus(conn, domain), hasRealCert(conn, domain)]);
    return { ...st, domain, certSupported: supported };
  });

  /** 签发 ACME 证书(standalone HTTP-01,需 80 端口空闲且域名解析到本机) */
  app.post('/:id/issue-cert', async (req) => {
    const { id } = idParam.parse(req.params);
    const row = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(id) as any;
    if (!row) throw Object.assign(new Error('服务器不存在'), { statusCode: 404 });
    const domain = row.client_host || row.host;
    if (!domain || /^\d+\.\d+\.\d+\.\d+$/.test(domain) || domain.includes(':')) {
      throw Object.assign(new Error(`机器地址 ${domain} 不是域名,无法签发 ACME 证书(需先设置 client_host 为域名)`), { statusCode: 400 });
    }
    const conn = serverConn(getDb(), id);
    try {
      return await issueCert(conn, domain);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /** 一键添加模板节点(按机器勾选模板;Reality 用 SNI 库选域名;同模板已存在则跳过) */
  app.post('/:id/batch-nodes', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({
      core: z.enum(['singbox', 'xray']),
      templates: z.array(z.string().min(1)).min(1, '至少选择一个模板'),
      realitySni: z.string().optional(),
    }).parse(req.body);
    return batchCreateNodes(getDb(), id, b);
  });

  void actionParam;
}
