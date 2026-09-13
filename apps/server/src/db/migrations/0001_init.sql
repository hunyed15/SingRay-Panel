-- 0001: baseline schema, ported from singbox-panel db.js (incremental ALTERs folded in).
-- port_forwards gains `mechanism` (design.md §4): explicit iptables | socat, no silent fallback.

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('relay','landing')),
  control TEXT NOT NULL DEFAULT 'ssh' CHECK(control IN ('ssh','agent')),
  host TEXT NOT NULL DEFAULT '',
  client_host TEXT NOT NULL DEFAULT '',
  ssh_port INTEGER NOT NULL DEFAULT 22,
  ssh_user TEXT NOT NULL DEFAULT 'root',
  ssh_auth_type TEXT NOT NULL DEFAULT 'key' CHECK(ssh_auth_type IN ('key','password')),
  ssh_auth_secret TEXT NOT NULL DEFAULT '',
  ssh_sudo INTEGER NOT NULL DEFAULT 0,
  region TEXT NOT NULL DEFAULT '',
  ping_status TEXT NOT NULL DEFAULT 'unknown' CHECK(ping_status IN ('online','inactive','offline','unknown')),
  singbox_version TEXT NOT NULL DEFAULT '',
  xray_version TEXT NOT NULL DEFAULT '',
  xray_ping_status TEXT NOT NULL DEFAULT 'unknown' CHECK(xray_ping_status IN ('online','inactive','offline','unknown')),
  xray_last_seen TEXT,
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS relay_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE,
  reality_public_key TEXT NOT NULL,
  reality_private_key TEXT NOT NULL,
  short_id TEXT NOT NULL,
  port_base INTEGER NOT NULL DEFAULT 31000
);

CREATE TABLE IF NOT EXISTS landing_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE,
  in_port INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT '2022-blake3-aes-128-gcm',
  password TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  listen_port INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  creds_enc TEXT NOT NULL DEFAULT '',
  tls_mode TEXT NOT NULL DEFAULT 'none' CHECK(tls_mode IN ('none','reality','tls','shadowtls')),
  sni TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'raw' CHECK(transport IN ('raw','ws')),
  ws_path TEXT NOT NULL DEFAULT '',
  outbound_type TEXT NOT NULL DEFAULT 'direct' CHECK(outbound_type IN ('direct','relay')),
  landing_server_id INTEGER REFERENCES servers(id),
  tunnel_address TEXT NOT NULL DEFAULT '',
  tunnel_port INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(server_id, listen_port)
);

CREATE TABLE IF NOT EXISTS sni_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS xray_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  listen_port INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  creds_enc TEXT NOT NULL DEFAULT '',
  tls_mode TEXT NOT NULL DEFAULT 'reality' CHECK(tls_mode IN ('none','reality','tls')),
  sni TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'raw' CHECK(transport IN ('raw','ws','tcp')),
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

CREATE TABLE IF NOT EXISTS xray_server_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE,
  reality_private_key TEXT NOT NULL,
  reality_public_key TEXT NOT NULL,
  short_id TEXT NOT NULL,
  port_base INTEGER NOT NULL DEFAULT 41000,
  in_port INTEGER,
  in_method TEXT NOT NULL DEFAULT 'aes-128-gcm',
  in_password_enc TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS port_forwards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  entry_server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  landing_server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_node_type TEXT NOT NULL CHECK(target_node_type IN ('singbox','xray')),
  target_node_id INTEGER NOT NULL,
  entry_port INTEGER NOT NULL,
  target_port INTEGER NOT NULL,
  mechanism TEXT NOT NULL DEFAULT 'iptables' CHECK(mechanism IN ('iptables','socat')),
  enabled INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(entry_server_id, entry_port)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
