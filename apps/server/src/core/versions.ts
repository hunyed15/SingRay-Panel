// 核心版本的默认值:**固定**版本,不追 latest。
//
// 理由:面板会在部署时自动安装核心二进制;默认 latest 意味着"某天上游发版,
// 你的机器第二天就跑上了没人验证过的核心"。升级应该是显式动作:
//   - 改 SINBOX_VERSION / XRAY_VERSION 环境变量,
//   - 或先用「回退版本」(lifecycle rollback)留好退路。
export const PINNED_SINGBOX_VERSION = '1.13.18';
export const PINNED_XRAY_VERSION = '24.11.30';

/** 合法取值:`latest` 或 `x.y.z`(允许前缀 v) */
export const isVersionSpec = (v: string): boolean => v === 'latest' || /^v?\d+\.\d+\.\d+$/.test(v);
