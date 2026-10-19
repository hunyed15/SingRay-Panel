-- 0011: 机器「可用端口」白名单(NAT 场景)
-- NAT 机器只有固定端口能对外,端口段由服务商映射(公网端口 = 内网端口,不做映射表)。
-- port_allow 形如 "32679-32699,30000,30100-30110";空串 = 不限制(原有行为)。
-- 约束范围:该机节点监听端口 + 该机作为中转入口时的入口端口。
ALTER TABLE servers ADD COLUMN port_allow TEXT NOT NULL DEFAULT '';
