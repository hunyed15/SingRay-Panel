import { describe, it, expect } from 'vitest';
import { parseStatsQueryOutput, cumulativeDelta } from './traffic.js';

const XRAY_OUT = JSON.stringify({
  stats: [
    { name: 'inbound>>>relay-in-31001>>>traffic>>>uplink', value: '1000' },
    { name: 'inbound>>>relay-in-31001>>>traffic>>>downlink', value: '50000' },
    { name: 'inbound>>>landing-in-20408>>>traffic>>>downlink', value: '999' },
    { name: 'inbound>>>api-in>>>traffic>>>uplink', value: '77' },
  ],
});

describe('traffic stats parsing', () => {
  it('parses xray statsquery output, skips api-in, aggregates per tag', () => {
    const stats = parseStatsQueryOutput('xray', XRAY_OUT);
    expect(stats).toHaveLength(2); // api-in 被排除
    const relay = stats.find((s) => s.tag === 'relay-in-31001')!;
    expect(relay.uplink).toBe(1000);
    expect(relay.downlink).toBe(50000);
    const landing = stats.find((s) => s.tag === 'landing-in-20408')!;
    expect(landing.downlink).toBe(999);
  });

  it('returns empty on garbage output (core not running / old config)', () => {
    expect(parseStatsQueryOutput('xray', 'command not found')).toEqual([]);
    expect(parseStatsQueryOutput('xray', '')).toEqual([]);
  });

  it('cumulativeDelta sums positive deltas only (counter reset handled)', () => {
    expect(cumulativeDelta([100, 300, 500])).toBe(400);
    expect(cumulativeDelta([100, 50, 80])).toBe(30); // 中途归零:50 段丢弃,50→80 计 30
    expect(cumulativeDelta([100])).toBe(0);
  });
});
