// 部署路由:单机双核心/单核心 + 一键部署全部(后台任务 + 轮询进度)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { deployAll, deployServerBothCores } from '../services/deployAll.js';
import { listPendingDeploys } from '../services/deployState.js';
import { genRandomHex } from '../core/crypto.js';
import type { MachineDeployResult } from '../services/deployAll.js';

const idParam = z.object({ id: z.coerce.number().int() });
const coreSchema = z.object({ core: z.enum(['singbox', 'xray']).optional() });

interface JobMachine {
  serverId: number;
  name: string;
  status: 'pending' | 'done';
  result?: MachineDeployResult;
}

interface DeployJob {
  id: string;
  startedAt: number;
  done: boolean;
  machines: JobMachine[];
}

/** 内存任务表(单管理员自用;进程重启即清,无持久化需求) */
const jobs = new Map<string, DeployJob>();

function pruneJobs(): void {
  const cutoff = Date.now() - 3600_000;
  for (const [id, j] of jobs) if (j.done && j.startedAt < cutoff) jobs.delete(id);
}

export default async function deployRoutes(app: FastifyInstance): Promise<void> {
  /** 待部署清单(服务器页"有未下发变更"横幅) */
  app.get('/pending', async () => listPendingDeploys(getDb()));

  /** 一键部署全部:启动后台任务,前端轮询 /status/:jobId 实时进度 */
  app.post('/all', async (req, reply) => {
    pruneJobs();
    const running = [...jobs.values()].find((j) => !j.done);
    if (running) {
      return reply.code(409).send({ error: '已有部署任务进行中', jobId: running.id });
    }
    const db = getDb();
    const servers = db.prepare("SELECT id, name FROM servers WHERE control = 'ssh' ORDER BY id").all() as { id: number; name: string }[];
    const job: DeployJob = {
      id: genRandomHex(6),
      startedAt: Date.now(),
      done: false,
      machines: servers.map((s) => ({ serverId: s.id, name: s.name, status: 'pending' })),
    };
    jobs.set(job.id, job);
    void (async () => {
      await deployAll(db, undefined, (result) => {
        const m = job.machines.find((x) => x.serverId === result.serverId);
        if (m) {
          m.result = result;
          m.status = 'done';
        }
      });
      job.done = true;
    })().catch(() => {
      job.done = true;
    });
    return { jobId: job.id, machines: job.machines };
  });

  /** 部署任务进度 */
  app.get('/status/:jobId', async (req, reply) => {
    const { jobId } = z.object({ jobId: z.string().min(1) }).parse(req.params);
    const job = jobs.get(jobId);
    if (!job) return reply.code(404).send({ error: '任务不存在或已过期' });
    return { id: job.id, done: job.done, machines: job.machines };
  });

  /** 单机部署(body.core 缺省 = sing-box + xray 都部署;同步等待) */
  app.post('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { core } = coreSchema.parse(req.body ?? {});
    return deployServerBothCores(getDb(), id, undefined, core);
  });
}
