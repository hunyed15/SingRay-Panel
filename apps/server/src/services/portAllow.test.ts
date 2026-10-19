import { describe, it, expect } from 'vitest';
import { parsePortAllow, containsPort, portAllowCount, describePortRanges, normalizeRanges } from './portAllow.js';

describe('port allow: parsing', () => {
  it('empty means unrestricted', () => {
    expect(parsePortAllow('')).toEqual({ ranges: [] });
    expect(parsePortAllow('   ')).toEqual({ ranges: [] });
    expect(parsePortAllow(null)).toEqual({ ranges: [] });
  });

  it('parses ranges, single ports and mixed separators', () => {
    const { ranges, error } = parsePortAllow('32679-32699, 30000，30100~30110、40000');
    expect(error).toBeUndefined();
    expect(ranges).toEqual([
      { start: 30000, end: 30000 },
      { start: 30100, end: 30110 },
      { start: 32679, end: 32699 },
      { start: 40000, end: 40000 },
    ]);
  });

  it('merges overlapping and adjacent ranges (count stays accurate)', () => {
    const { ranges } = parsePortAllow('30000-30010,30005-30015,30016');
    expect(ranges).toEqual([{ start: 30000, end: 30016 }]);
    expect(portAllowCount(ranges)).toBe(17);
  });

  it('rejects illegal tokens with a user-facing message', () => {
    expect(parsePortAllow('abc').error).toMatch(/无法识别的端口写法/);
    expect(parsePortAllow('30000-').error).toMatch(/无法识别的端口写法/);
    expect(parsePortAllow('70000').error).toMatch(/端口超出范围/);
    expect(parsePortAllow('0').error).toMatch(/端口超出范围/);
    expect(parsePortAllow('30010-30000').error).toMatch(/起止倒置/);
    // 任一段非法则整体拒绝,不做部分采纳(避免用户以为存进去了)
    expect(parsePortAllow('30000-30010,bad').ranges).toEqual([]);
  });

  it('containsPort / describePortRanges', () => {
    const { ranges } = parsePortAllow('32679-32699,30000');
    expect(containsPort(ranges, 32679)).toBe(true);
    expect(containsPort(ranges, 32699)).toBe(true);
    expect(containsPort(ranges, 32700)).toBe(false);
    expect(containsPort(ranges, 30000)).toBe(true);
    expect(describePortRanges(ranges)).toBe('30000,32679-32699');
    // 无限制时空区间不会误判
    expect(containsPort([], 12345)).toBe(false);
  });

  it('truncates long range lists in descriptions', () => {
    const ranges = normalizeRanges([
      { start: 1, end: 1 },
      { start: 3, end: 3 },
      { start: 5, end: 5 },
      { start: 7, end: 7 },
      { start: 9, end: 9 },
      { start: 11, end: 11 },
    ]);
    expect(describePortRanges(ranges)).toContain('…(共 6 段/6 个端口)');
    expect(describePortRanges(ranges, 10)).toBe('1,3,5,7,9,11');
  });
});
