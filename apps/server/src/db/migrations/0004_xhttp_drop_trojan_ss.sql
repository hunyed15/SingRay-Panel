-- 0004: xhttp 传输支持 + 移除 Trojan/Shadowsocks 协议
-- 1) xray_nodes 重建:transport CHECK 扩展 'xhttp'
CREATE TABLE xray_nodes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  listen_port INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  creds_enc TEXT NOT NULL DEFAULT '',
  tls_mode TEXT NOT NULL DEFAULT 'reality' CHECK(tls_mode IN ('none','reality','tls')),
  sni TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'raw' CHECK(transport IN ('raw','ws','tcp','xhttp')),
  ws_path TEXT NOT NULL DEFAULT '',
  flow TEXT NOT NULL DEFAULT '',
  outbound_type TEXT NOT NULL DEFAULT 'direct' CHECK(outbound_type IN ('direct','relay')),
  landing_server_id INTEGER REFERENCES servers(id),
  tunnel_address TEXT NOT NULL DEFAULT '',
  tunnel_port INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(server_id, listen_port)
);
INSERT INTO xray_nodes_new (id, name, server_id, protocol, listen_port, enabled, creds_enc, tls_mode, sni, transport, ws_path, flow, outbound_type, landing_server_id, tunnel_address, tunnel_port, note, created_at)
  SELECT id, name, server_id, protocol, listen_port, enabled, creds_enc, tls_mode, sni, transport, ws_path, flow, outbound_type, landing_server_id, tunnel_address, tunnel_port, note, created_at FROM xray_nodes;
DROP TABLE xray_nodes;
ALTER TABLE xray_nodes_new RENAME TO xray_nodes;

-- 2) 协议矩阵收缩:删除 Trojan / Shadowsocks 节点(双核心)
DELETE FROM xray_nodes WHERE protocol IN ('trojan', 'shadowsocks');
DELETE FROM nodes WHERE protocol = 'trojan';
