// 中转拓扑:状态预览 / 手动同步 / IP 栈探测
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { loadMachines, loadRelayableNodes, planTopology, diffRules, nodesOutsidePortAllow } from '../core/topology/plan.js';
import { syncTopology } from '../core/topology/sync.js';
import { detectIpStack, detectAllIpStacks } from '../core/topology/ipstack.js';

export default async function topologyRoutes(app: FastifyInstance): Promise<void> {
  /** 拓扑预览:机器 IP 栈 + 期望规则 + 与现状的差异(含端口白名单造成的跳过/告警) */
  app.get('/', async () => {
    const db = getDb();
    const machines = loadMachines(db);
    const nodes = loadRelayableNodes(db);
    const plan = planTopology(machines, nodes);
    const diff = diffRules(db, plan.rules);
    return {
      machines: machines.map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        ipStack: m.ipStack,
        relayMechanism: m.relayMechanism,
        portAllow: m.portAllow,
      })),
      desired: plan.rules.map((d) => ({ ...d, entryName: machines.find((m) => m.id === d.entryServerId)?.name, landingName: machines.find((m) => m.id === d.landingServerId)?.name })),
      /** 端口白名单挡掉的链路(不生成规则) */
      skipped: plan.skipped,
      /** 存量告警:节点端口不在自己机器白名单内(不自动改号) */
      portAllowWarnings: nodesOutsidePortAllow(machines, nodes),
      diff: { toCreate: diff.toCreate.length, toDelete: diff.toDelete.length, toDeleteList: diff.toDelete },
    };
  });

  /** 手动触发同步(等待完成) */
  app.post('/sync', async () => syncTopology(getDb()));

  /** 探测所有机器的 IP 栈 */
  app.post('/detect-ip', async () => ({ ok: true, summary: await detectAllIpStacks(getDb()) }));

  /** 探测单机 IP 栈 */
  app.post('/detect-ip/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return { ipStack: await detectIpStack(getDb(), id) };
  });
}
