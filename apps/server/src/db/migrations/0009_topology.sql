-- 0009: 自动中转拓扑
-- servers.ip_stack        机器 IP 栈(v4/v6/dual/unknown),SSH 自动探测
-- servers.relay_mechanism 该机作为中转入口时的转发机制偏好(iptables/socat)
-- port_forwards.auto      1 = 拓扑自动生成(同步器管理),0 = 手工创建(同步器不碰)
ALTER TABLE servers ADD COLUMN ip_stack TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE servers ADD COLUMN relay_mechanism TEXT NOT NULL DEFAULT 'socat';

-- SQLite 需重建表以扩展列(沿用 0008 的做法)
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
  auto INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(entry_server_id, entry_port)
);

INSERT INTO port_forwards_new
  SELECT id, name, entry_server_id, landing_server_id, target_node_type, target_node_id,
         entry_port, target_port, mechanism, include_in_sub, enabled, 0, note, created_at
  FROM port_forwards;

DROP TABLE port_forwards;
ALTER TABLE port_forwards_new RENAME TO port_forwards;
