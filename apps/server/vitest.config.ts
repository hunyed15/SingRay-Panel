import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // config.ts 的弱密钥守卫已与监听地址解耦(默认值一律拒绝启动),
    // 因此测试必须在加载 config 之前显式提供强密钥 —— setupFiles 保证了这个顺序。
    setupFiles: ['./src/testSetup.ts'],
  },
});
