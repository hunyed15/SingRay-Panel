// 公开订阅端点(免鉴权,slug 混淆)。
// /sub/<slug>          → 自适应:sing-box UA → JSON / clash·mihomo UA → YAML / 其余 → base64
// /sub/singbox/:slug   → 恒 sing-box JSON(不依赖 UA——GUI.for.SingBox 等自定义 UA 不可靠)
// /sub/xray/:slug      → 恒 base64 链接(v2rayN 纯 Xray 路线)
// 订阅内容 = 启用节点 + include_in_sub 中转线路;Reality 地址 IP/域名由设置开关控制。
//
// 安全:订阅内容含节点凭据 → 一律 no-store(不准中间层缓存);每 IP 限流,
// 降低 slug 被枚举的风险(slug 至少 8 位,见 settings.putSettings)。
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { collectSingboxNodes, collectXrayNodes, realityAddrFor } from '../services/subs.js';
import { toClashYaml } from '../core/subscribe/clash.js';
import { toBase64, toSingboxConfig } from '../core/subscribe/index.js';
import { genRandomHex } from '../core/crypto.js';

const SINGBOX_UA = /sing-box|singbox|\bSFI\b|\bSFA\b|\bSFM\b|GUI\.for\.SingBox/i;
const CLASH_UA = /clash|mihomo|meta|stash|verge/i;
/** 每 IP 每分钟(客户端刷新是小时级,120 足够,同时压住枚举尝试) */
const SUB_ROUTE = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

function ensureSubSlug(db: ReturnType<typeof getDb>): string {
  let slug = db.prepare("SELECT value FROM settings WHERE key = 'sub_slug'").get() as { value: string } | undefined;
  if (!slug) {
    const value = genRandomHex(6); // 12 个 hex 字符 = 48 bit
    db.prepare("INSERT INTO settings (key, value) VALUES ('sub_slug', ?)").run(value);
    slug = { value };
  }
  return slug.value;
}

/** slug 不符直接 404(不区分"不存在/猜错",避免被探测);命中返回 true */
function guardSlug(req: any, reply: any): boolean {
  if (ensureSubSlug(getDb()) === (req.params as { slug: string }).slug) return true;
  reply.code(404).send({ error: 'not found' });
  return false;
}

/** 自适应订阅(挂在 /sub 下):按 UA 分派三种格式 */
export default async function subRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:slug', SUB_ROUTE, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!guardSlug(req, reply)) return reply;
    const db = getDb();
    const ua = (req.headers['user-agent'] as string) || '';
    if (SINGBOX_UA.test(ua)) {
      const views = collectSingboxNodes(db, realityAddrFor(db, 'singbox'));
      return reply.type('application/json').send(JSON.stringify(toSingboxConfig(views), null, 2));
    }
    if (CLASH_UA.test(ua)) {
      const views = [...collectXrayNodes(db, realityAddrFor(db, 'xray')), ...collectSingboxNodes(db, realityAddrFor(db, 'singbox'))];
      return reply.type('text/yaml; charset=utf-8').send(toClashYaml(views));
    }
    const views = collectXrayNodes(db, realityAddrFor(db, 'xray'));
    return reply.type('text/plain').send(toBase64(views));
  });
}

/** SingBox 专用订阅(挂在 /sub/singbox 下):恒 sing-box JSON */
export async function singboxSubRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:slug', SUB_ROUTE, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!guardSlug(req, reply)) return reply;
    const views = collectSingboxNodes(getDb(), realityAddrFor(getDb(), 'singbox'));
    return reply.type('application/json').send(JSON.stringify(toSingboxConfig(views), null, 2));
  });
}

/** Xray/通用订阅(挂在 /sub/xray 下):恒 base64 链接 */
export async function xraySubRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:slug', SUB_ROUTE, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!guardSlug(req, reply)) return reply;
    return reply.type('text/plain').send(toBase64(collectXrayNodes(getDb(), realityAddrFor(getDb(), 'xray'))));
  });
}
