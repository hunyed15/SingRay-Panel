-- 0003: SSH 跳板机 —— 通过另一台机器(如 Dedirock)隧道连接目标机器
ALTER TABLE servers ADD COLUMN jump_server_id INTEGER REFERENCES servers(id);
