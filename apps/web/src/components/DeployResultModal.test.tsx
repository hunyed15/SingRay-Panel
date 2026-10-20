// 部署结果弹窗:成败标签与失败原因必须一眼可见(P1-03 的回归防线)
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeployResultModal } from './DeployResultModal';
import type { DeployAllResult } from '../services/types';

const ok = {
  serverId: 1,
  serverName: 'HK1',
  singbox: { ok: true, steps: [] },
  xray: { ok: true, steps: [] },
} as unknown as DeployAllResult;

const failed = {
  serverId: 2,
  serverName: 'JP1',
  singbox: { ok: false, error: 'reload failed: exit 1', steps: [] },
  xray: { ok: true, skipped: true, steps: [] },
} as unknown as DeployAllResult;

describe('DeployResultModal', () => {
  it('全部成功 → 标题为「完成」', () => {
    render(<DeployResultModal open results={[ok]} onClose={() => {}} />);
    expect(screen.getByText('部署全部 — 完成')).toBeInTheDocument();
  });

  it('有机器失败 → 标题为「部分失败」,并显示失败原因与「跳过」标签', () => {
    render(<DeployResultModal open results={[ok, failed]} onClose={() => {}} />);
    expect(screen.getByText('部署全部 — 部分失败')).toBeInTheDocument();
    expect(screen.getByText('reload failed: exit 1')).toBeInTheDocument();
    expect(screen.getByText('跳过')).toBeInTheDocument();
    // 成功的机器不显示错误文本
    expect(screen.queryByText('HK1')).toBeInTheDocument();
  });

  it('支持自定义标题(单机部署复用同一弹窗)', () => {
    render(<DeployResultModal open results={[ok]} onClose={() => {}} title="部署 — 结果" />);
    expect(screen.getByText('部署 — 结果')).toBeInTheDocument();
  });
});
