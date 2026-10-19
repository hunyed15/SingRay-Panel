// 测试环境的强密钥 / 口令。
// 必须在任何模块 import config.ts 之前生效 —— 由 vitest.config.ts 的 setupFiles 注册。
// 注意:这里的口令不是产品默认值,只是让既有鉴权用例保持可用的测试夹具;
// 「未配置口令时随机生成」的行为由 services/users.test.ts 单独覆盖。
process.env.PANEL_JWT_SECRET ||= 'vitest-jwt-secret-6f2a9c1d4b8e7f30';
process.env.PANEL_APP_SECRET ||= 'vitest-app-secret-91c3e5a7b2d8f406';
process.env.PANEL_ADMIN_PASSWORD ||= 'admin888';
