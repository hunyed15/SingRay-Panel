// 机器「可用端口」白名单解析(NAT 场景:服务商只映射固定端口/端口段)。
//
// 格式:`32679-32699,30000,30100-30110`
//   - 区间与单端口混写,逗号(半角/全角)或空白分隔
//   - 归一化 = 排序 + 合并重叠/相邻区间,便于「剩余可用端口」计数
//   - 空串 = 不限制(原有行为,向后兼容)
//
// 这是纯函数模块:拓扑规划(纯函数)与端口分配(碰 DB)都只用这里的结果。

export interface PortRange {
  start: number;
  end: number;
}

export interface PortAllowParseResult {
  /** 归一化后的区间;空数组 = 不限制 */
  ranges: PortRange[];
  /** 首个错误(有值时 ranges 恒为空) */
  error?: string;
}

export const PORT_MIN = 1;
export const PORT_MAX = 65535;

const TOKEN_SEPARATOR = /[,，、\s]+/;
const TOKEN_RANGE = /^(\d{1,5})[-~](\d{1,5})$/;
const TOKEN_SINGLE = /^\d{1,5}$/;

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= PORT_MIN && n <= PORT_MAX;
}

/** 解析白名单文本。错误信息直接面向用户(面板表单会原样展示)。 */
export function parsePortAllow(text: string | null | undefined): PortAllowParseResult {
  const raw = (text ?? '').trim();
  if (!raw) return { ranges: [] };

  const parsed: PortRange[] = [];
  for (const token of raw.split(TOKEN_SEPARATOR).filter(Boolean)) {
    const range = TOKEN_RANGE.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!isValidPort(start) || !isValidPort(end)) {
        return { ranges: [], error: `端口超出范围(${PORT_MIN}-${PORT_MAX}):${token}` };
      }
      if (start > end) return { ranges: [], error: `端口区间起止倒置:${token}(应写成 ${end}-${start})` };
      parsed.push({ start, end });
      continue;
    }
    if (TOKEN_SINGLE.test(token)) {
      const port = Number(token);
      if (!isValidPort(port)) return { ranges: [], error: `端口超出范围(${PORT_MIN}-${PORT_MAX}):${token}` };
      parsed.push({ start: port, end: port });
      continue;
    }
    return { ranges: [], error: `无法识别的端口写法:"${token}"(示例:32679-32699,30000)` };
  }

  return { ranges: normalizeRanges(parsed) };
}

/** 排序 + 合并重叠/相邻区间(相邻合并只是展示与计数更准,不影响可用端口集合) */
export function normalizeRanges(ranges: PortRange[]): PortRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: PortRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) {
      if (r.end > last.end) last.end = r.end;
      continue;
    }
    out.push({ start: r.start, end: r.end });
  }
  return out;
}

export function containsPort(ranges: PortRange[], port: number): boolean {
  return ranges.some((r) => port >= r.start && port <= r.end);
}

export function portAllowCount(ranges: PortRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
}

/** 紧凑展示:`32679-32699,30000`;区间过多时截断,避免错误信息过长 */
export function describePortRanges(ranges: PortRange[], maxParts = 4): string {
  const parts = ranges.map((r) => (r.start === r.end ? String(r.start) : `${r.start}-${r.end}`));
  if (parts.length <= maxParts) return parts.join(',');
  return `${parts.slice(0, maxParts).join(',')}…(共 ${parts.length} 段/${portAllowCount(ranges)} 个端口)`;
}
