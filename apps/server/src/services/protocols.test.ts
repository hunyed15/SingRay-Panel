// 订阅/中转协议口径的单一事实源:SQL 字面量格式被直接拼进查询,锁一下
import { describe, it, expect } from 'vitest';
import {
  NOT_SUBSCRIBABLE_SINGBOX,
  NOT_SUBSCRIBABLE_SINGBOX_SQL,
  NOT_SUBSCRIBABLE_XRAY_SQL,
  NOT_RELAYABLE,
} from './protocols.js';

describe('protocols 口径', () => {
  it('sing-box / xray 的订阅排除项', () => {
    expect(NOT_SUBSCRIBABLE_SINGBOX_SQL).toBe("('tunnel', 'socks', 'http')");
    expect(NOT_SUBSCRIBABLE_XRAY_SQL).toBe("('socks', 'http')");
  });

  it('中转排除项与 sing-box 订阅口径一致', () => {
    for (const p of NOT_SUBSCRIBABLE_SINGBOX) expect(NOT_RELAYABLE.has(p)).toBe(true);
    expect(NOT_RELAYABLE.has('vless')).toBe(false);
  });
});
