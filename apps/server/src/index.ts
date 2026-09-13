import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { ZodError } from 'zod';
import { config } from './config.js';
import { getDb } from './db/client.js';
import { HttpError } from './services/errors.js';
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

const DIR = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';

/** 免鉴权路径(Bearer 校验范围 = 其余全部 /api/*;订阅公开端点属 M5) */
const PUBLIC_API_PATHS = new Set(['/api/auth/login']);

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  await app.register(jwt, { secret: config.jwtSecret });

  // 统一错误出口:HttpError/ZodError → { error };其余 5xx
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: err.issues[0]?.message ?? '参数错误' });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message });
    }
    app.log.error(err as Error);
    return reply.code(500).send({ error: 'internal error' });
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
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
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
  // 公开订阅端点(非 /api 前缀,不经过 Bearer 校验)
  await app.register(singboxSubRoutes, { prefix: '/sub/singbox' });
  await app.register(xraySubRoutes, { prefix: '/sub/xray' });
  // 自适应订阅(按 UA 分派,老地址继续可用)
  await app.register(subRoutes, { prefix: '/sub' });

  return app;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  buildApp()
    .then((app) => app.listen({ port: config.port, host: config.host }))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
