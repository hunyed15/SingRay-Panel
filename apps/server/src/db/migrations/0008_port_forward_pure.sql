-- 0008: 中转规则支持"纯端口转发"模式(两跳中转)
-- target_node_type='port' 时不绑定节点,target_node_id 无意义;
-- 用于 CDT → Hytron(socat) → JP 这类中间跳场景
-- SQLite 需重建表以扩展 CHECK 约束
CREATE TABLE port_forwards_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  entry_server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  landing_server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_node_type TEXT NOT NULL CHECK(target_node_type IN ('singbox','xray','port')),
  target_node_id INTEGER NOT NULL DEFAULT 0,
  entry_port INTEGER NOT NULL,
  target_port INTEGER NOT NULL,
  mechanism TEXT NOT NULL DEFAULT 'iptables' CHECK(mechanism IN ('iptables','socat')),
  include_in_sub INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(entry_server_id, entry_port)
);

INSERT INTO port_forwards_new
  SELECT id, name, entry_server_id, landing_server_id, target_node_type, target_node_id,
         entry_port, target_port, mechanism, include_in_sub, enabled, note, created_at
  FROM port_forwards;

DROP TABLE port_forwards;
ALTER TABLE port_forwards_new RENAME TO port_forwards;
