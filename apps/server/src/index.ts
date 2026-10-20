import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { getDb } from './db/client.js';
import { HttpError, codeForStatus } from './services/errors.js';
import { bootstrapAdmin } from './services/users.js';
import { seedSniLibrary } from './services/snis.js';
import authRoutes from './routes/auth.js';
import serverRoutes from './routes/servers.js';
import nodeRoutes from './routes/nodes.js';
import xrayNodeRoutes from './routes/xray_nodes.js';
import sniRoutes from './routes/snis.js';
import settingsRoutes from './routes/settings.js';
import lifecycleRoutes from './routes/lifecycle.js';
import deployRoutes from './routes/deploy.js';
import portForwardRoutes from './routes/port_forwards.js';
import testRoutes from './routes/test.js';
import subRoutes, { singboxSubRoutes, xraySubRoutes } from './routes/sub.js';
import systemRoutes from './routes/system.js';
import trafficRoutes from './routes/traffic.js';
import topologyRoutes from './routes/topology.js';
import { registerJob, startScheduler } from './core/scheduler.js';
import { runBackupNow, backedUpToday } from './core/backup.js';
import { runHealthCheckCycle } from './core/healthcheck.js';
import { collectAllTraffic } from './core/traffic.js';
import { probeAllNodes } from './services/autoProbe.js';
import { recordRun } from './core/alerts.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';

/** 免鉴权路径(Bearer 校验范围 = 其余全部 /api/*;订阅公开端点属 M5) */
const PUBLIC_API_PATHS = new Set(['/api/auth/login']);

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: config.trustProxy });

  await app.register(jwt, { secret: config.jwtSecret });
  await app.register(rateLimit, { global: false });

  // 统一错误出口:{ error: 中文消息, code: 机器可读码 };其余 5xx
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: err.issues[0]?.message ?? '参数错误', code: 'bad_request' });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message, code: codeForStatus(status) });
    }
    app.log.error(err as Error);
    return reply.code(500).send({ error: 'internal error', code: 'internal' });
  });

  app.get('/health', async () => ({ ok: true, name: 'singray-panel', version: VERSION }));

  const db = getDb();
  await bootstrapAdmin(db);
  seedSniLibrary(db);

  // 全局 Bearer 校验(hook 需先于路由注册,子插件才能继承)
  app.addHook('onRequest', async (req, reply) => {
    const routePath = req.url.split('?')[0];
    if (!routePath.startsWith('/api') || PUBLIC_API_PATHS.has(routePath)) return;
    try {
      await req.jwtVerify();
      // 会话版本校验:改密码后 token_version 已递增,旧 token 立刻失效
      const u = getDb().prepare('SELECT token_version FROM users WHERE id = ?').get(req.user.sub) as
        | { token_version: number }
        | undefined;
      if (!u || u.token_version !== req.user.v) return reply.code(401).send({ error: 'unauthorized', code: 'unauthorized' });
    } catch {
      return reply.code(401).send({ error: 'unauthorized', code: 'unauthorized' });
    }
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(serverRoutes, { prefix: '/api/servers' });
  await app.register(lifecycleRoutes, { prefix: '/api/servers' });
  await app.register(nodeRoutes, { prefix: '/api/nodes' });
  await app.register(xrayNodeRoutes, { prefix: '/api/xray/nodes' });
  await app.register(sniRoutes, { prefix: '/api/snis' });
  await app.register(settingsRoutes, { prefix: '/api/settings' });
  await app.register(deployRoutes, { prefix: '/api/deploy' });
  await app.register(portForwardRoutes, { prefix: '/api/port-forwards' });
  await app.register(testRoutes, { prefix: '/api/test' });
  await app.register(systemRoutes, { prefix: '/api/system' });
  await app.register(trafficRoutes, { prefix: '/api/traffic' });
  await app.register(topologyRoutes, { prefix: '/api/topology' });
  // 公开订阅端点(非 /api 前缀,不经过 Bearer 校验)
  await app.register(singboxSubRoutes, { prefix: '/sub/singbox' });
  await app.register(xraySubRoutes, { prefix: '/sub/xray' });
  // 自适应订阅(按 UA 分派,老地址继续可用)
  await app.register(subRoutes, { prefix: '/sub' });

  return app;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  // 运维调度:每日备份(到点且今日未备才执行) + 周期健康检查
  buildApp()
    .then(async (app) => {
      const db = getDb();
      /**
       * 任务结果统一记账:成功 ok=1、失败 ok=0 并继续抛给调度器。
       * 旧实现里三个任务都无条件 recordRun(...,true),机器全掉线时 job_runs 仍是绿的。
       */
      const job = (name: string, fn: () => Promise<string> | string) => async (): Promise<string> => {
        try {
          const detail = await fn();
          recordRun(db, name, true, detail);
          return detail;
        } catch (err) {
          recordRun(db, name, false, (err as Error).message);
          throw err;
        }
      };

      registerJob('backup', 30 * 60_000, job('backup', async () => {
        const hour = new Date().getHours();
        if (hour !== config.backupHour || backedUpToday()) return '未到备份时间或今日已备份,跳过';
        const r = runBackupNow(db);
        return `备份完成: ${r.file}`;
      }));
      registerJob('healthcheck', config.healthIntervalMin * 60_000, job('healthcheck', () => runHealthCheckCycle(db)));
      registerJob('traffic', 5 * 60_000, job('traffic', () => collectAllTraffic(db)));
      // 自动可用性探测:从面板侧连一下每个节点的实际入口(0 = 关闭)
      if (config.probeIntervalMin > 0) {
        registerJob(
          'probe',
          config.probeIntervalMin * 60_000,
          job('probe', async () => {
            const r = await probeAllNodes(db);
            return `探测 ${r.checked} 个节点,失败 ${r.failed}`;
          }),
        );
      }
      startScheduler();
      await app.listen({ port: config.port, host: config.host });
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
