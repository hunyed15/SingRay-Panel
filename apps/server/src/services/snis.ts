// SNI 域名库 CRUD(移植自旧 routes/snis.js)
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.js';

export interface SniRow {
  id: number;
  domain: string;
  note: string;
  builtin: number;
}

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export function listSnis(db: DatabaseSync): SniRow[] {
  return db.prepare('SELECT * FROM sni_library ORDER BY id').all() as unknown as SniRow[];
}

export function createSni(db: DatabaseSync, domain: string, note = ''): SniRow {
  const d = String(domain || '').trim();
  if (!DOMAIN_RE.test(d)) throw new HttpError(400, '域名格式不正确,如 www.example.com');
  const dup = db.prepare('SELECT id FROM sni_library WHERE domain = ?').get(d);
  if (dup) throw new HttpError(409, '该域名已存在');
  const info = db.prepare('INSERT INTO sni_library (domain, note, builtin) VALUES (?,?,0)').run(d, String(note).trim());
  return db.prepare('SELECT * FROM sni_library WHERE id = ?').get(info.lastInsertRowid) as unknown as SniRow;
}

export function updateSni(db: DatabaseSync, id: number, b: { domain?: string; note?: string }): SniRow {
  const row = db.prepare('SELECT * FROM sni_library WHERE id = ?').get(id) as unknown as SniRow | undefined;
  if (!row) throw new HttpError(404, '域名不存在');
  const domain = b.domain !== undefined ? String(b.domain).trim() : row.domain;
  if (!DOMAIN_RE.test(domain)) throw new HttpError(400, '域名格式不正确');
  const dup = db.prepare('SELECT id FROM sni_library WHERE domain = ? AND id != ?').get(domain, id);
  if (dup) throw new HttpError(409, '该域名已存在');
  db.prepare('UPDATE sni_library SET domain=?, note=? WHERE id=?').run(
    domain,
    b.note !== undefined ? String(b.note).trim() : row.note,
    id,
  );
  return db.prepare('SELECT * FROM sni_library WHERE id = ?').get(id) as unknown as SniRow;
}

export function deleteSni(db: DatabaseSync, id: number): void {
  const info = db.prepare('DELETE FROM sni_library WHERE id = ?').run(id);
  if (info.changes === 0) throw new HttpError(404, '域名不存在');
}

/** Reality 借站域名库内置种子(仅空表时插入,可编辑/删除)。
 * ✓实测可用/⚠️实测不兼容 标注基于 2026-08 CoreNet(HK)实测;结果与机器网络路径相关。 */
const SNI_SEED: [string, string][] = [
  ['www.microsoft.com', '微软官网 ⚠️实测不兼容'],
  ['www.apple.com', 'Apple 官网 ⚠️实测不兼容'],
  ['dl.google.com', 'Google 下载 ✓实测可用'],
  ['www.google.com', 'Google'],
  ['www.youtube.com', 'YouTube'],
  ['www.cloudflare.com', 'Cloudflare ✓实测可用'],
  ['gateway.icloud.com', 'iCloud'],
  ['swdist.apple.com', 'Apple 软件更新'],
  ['www.bing.com', 'Bing ✓实测可用'],
  ['support.microsoft.com', '微软支持'],
  ['www.office.com', 'Microsoft 365'],
  ['www.amazon.com', 'Amazon'],
  ['www.yahoo.com', 'Yahoo ⚠️实测不兼容'],
  ['www.oracle.com', 'Oracle ✓实测可用'],
  ['www.nvidia.com', 'NVIDIA ✓实测可用'],
  ['www.adobe.com', 'Adobe ✓实测可用'],
  ['www.samsung.com', '三星 ✓实测可用'],
  ['www.facebook.com', 'Facebook ⚠️实测不兼容'],
  ['www.instagram.com', 'Instagram ⚠️实测不兼容'],
  ['www.tiktok.com', 'TikTok ⚠️实测不兼容'],
  ['discord.com', 'Discord ⚠️实测不兼容'],
  ['www.netflix.com', 'Netflix ✓实测可用'],
  ['www.tesla.com', 'Tesla ✓实测可用'],
  ['www.cisco.com', 'Cisco ✓实测可用'],
  ['www.spotify.com', 'Spotify'],
  ['chat.openai.com', 'OpenAI'],
  ['www.paypal.com', 'PayPal ✓实测可用'],
];

export function seedSniLibrary(db: DatabaseSync): void {
  const count = (db.prepare('SELECT COUNT(*) c FROM sni_library').get() as { c: number }).c;
  if (count > 0) return;
  const ins = db.prepare('INSERT INTO sni_library (domain, note, builtin) VALUES (?, ?, 1)');
  for (const [domain, note] of SNI_SEED) ins.run(domain, note);
}
