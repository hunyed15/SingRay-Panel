import { describe, it, expect } from 'vitest';
import { isVersionSpec, PINNED_SINGBOX_VERSION, PINNED_XRAY_VERSION } from './versions.js';

describe('versions', () => {
  it('默认固定版本自身必须是合法版本号', () => {
    expect(isVersionSpec(PINNED_SINGBOX_VERSION)).toBe(true);
    expect(isVersionSpec(PINNED_XRAY_VERSION)).toBe(true);
  });

  it('只接受 latest 或 x.y.z(可带 v 前缀)', () => {
    for (const ok of ['latest', '1.13.18', 'v24.11.30', '0.0.1']) expect(isVersionSpec(ok)).toBe(true);
    for (const bad of ['', 'v24', '1.13', 'latestx', '1.13.18-beta', ' ']) expect(isVersionSpec(bad)).toBe(false);
  });
});
