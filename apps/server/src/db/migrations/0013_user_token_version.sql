-- 0013: 会话版本号 —— 改密码后让已签发的 JWT 立即失效(旧实现改完密码,旧 token 还能用满 12 小时)
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
