// 一键批量添加模板节点:按机器勾选模板,自动命名/分配端口/生成凭据。
// 命名规范: <机器名>-<模板名>-sb|-xray;同机器同模板已存在则跳过不去重覆盖。

import type { DatabaseSync } from 'node:sqlite';
import { TEMPLATE_META } from './templates.js';
import { XRAY_TEMPLATE_META } from './xray_templates.js';
import { createNode } from './nodes.js';
import { createXrayNode } from './xray_nodes.js';
import { HttpError } from './errors.js';
import type { Row } from './row.js';

export type BatchCore = 'singbox' | 'xray';

export interface BatchNodeInput {
  core: BatchCore;
  /** 模板键(singbox: vless-reality 等;xray: xray-vless-reality 等) */
  templates: string[];
  /** Reality 模板的 SNI(取自 SNI 域名库);不传用模板默认值 */
  realitySni?: string;
}

export interface BatchNodeResult {
  created: { name: string; port: number }[];
  skipped: { template: string; reason: string }[];
}

const SINGBOX_META = TEMPLATE_META as Record<string, { protocol: string; tlsMode: string; transport: string }>;

export function batchCreateNodes(db: DatabaseSync, serverId: number, b: BatchNodeInput): BatchNodeResult {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as Row | undefined;
  if (!server) throw new HttpError(404, '服务器不存在');
  if (!b.templates?.length) throw new HttpError(400, 'templates 不能为空');

  const result: BatchNodeResult = { created: [], skipped: [] };
  const meta = b.core === 'singbox' ? SINGBOX_META : (XRAY_TEMPLATE_META as Record<string, { protocol: string; tlsMode: string; transport: string }>);
  const table = b.core === 'singbox' ? 'nodes' : 'xray_nodes';
  const suffix = b.core === 'singbox' ? 'sb' : 'xray';

  for (const tpl of b.templates) {
    const m = meta[tpl];
    if (!m) {
      result.skipped.push({ template: tpl, reason: '未知模板' });
      continue;
    }
    // 同机器同模板(协议+TLS+传输一致)已存在 → 跳过
    const dup = db
      .prepare(`SELECT id, name FROM ${table} WHERE server_id = ? AND protocol = ? AND tls_mode = ? AND transport = ?`)
      .get(serverId, m.protocol, m.tlsMode, m.transport) as Row | undefined;
    if (dup) {
      result.skipped.push({ template: tpl, reason: `已存在: ${dup.name}` });
      continue;
    }
    const isReality = m.tlsMode === 'reality';
    const sni = isReality && b.realitySni ? b.realitySni : undefined;
    const name = `${server.name}-${tpl.replace(/^xray-/, '')}-${suffix}`;
    const node =
      b.core === 'singbox'
        ? createNode(db, { template: tpl, name, serverId, sni } as any)
        : createXrayNode(db, { template: tpl, name, serverId, sni } as any);
    result.created.push({ name: (node as Row).name, port: (node as Row).listen_port });
  }
  return result;
}
