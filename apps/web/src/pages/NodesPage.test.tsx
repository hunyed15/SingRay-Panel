// 页面级 smoke:NodesPage 能带着真实数据渲染(表格、探测列),不依赖手工点开浏览器
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from 'antd';

const fx = vi.hoisted(() => ({
  node: {
    id: 1,
    name: 'KEEP-HK',
    serverId: 1,
    serverName: 'HK1',
    protocol: 'vmess',
    listenPort: 30001,
    enabled: 1,
    tlsMode: 'tls',
    transport: 'ws',
    outboundType: 'direct',
    shareLink: 'vmess://abc',
    note: '',
    createdAt: '2026-10-19T00:00:00.000Z',
  },
  server: {
    id: 1,
    name: 'HK1',
    role: 'relay',
    control: 'ssh',
    host: '1.2.3.4',
    clientHost: '',
    sshPort: 22,
    sshUser: 'root',
    sshAuthType: 'password',
    sshSudo: 0,
    region: 'HK',
    pingStatus: 'online',
    singboxVersion: '1.13.18',
    xrayVersion: '',
    xrayPingStatus: 'unknown',
    xrayLastSeen: null,
    lastSeen: null,
    jumpServerId: null,
    ipStack: 'v4',
    relayMechanism: 'socat',
    preferViaServerId: null,
    portAllow: '',
  },
}));

vi.mock('../services/api', () => ({
  getNodes: vi.fn(async () => [fx.node]),
  getServers: vi.fn(async () => [fx.server]),
  getSnis: vi.fn(async () => []),
  getProbes: vi.fn(async () => [
    { nodeType: 'singbox', nodeId: 1, nodeName: 'KEEP-HK', ok: true, latencyMs: 42, detail: 'TCP connected', checkedAt: new Date().toISOString() },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ]),
  updateNode: vi.fn(),
  deleteNode: vi.fn(),
  testNode: vi.fn(),
}));

import { NodesPage } from './NodesPage';

describe('NodesPage', () => {
  it('渲染节点表格,并把自动探测结果放进「探测」列', async () => {
    render(
      <App>
        <NodesPage />
      </App>,
    );
    expect(screen.getByText('Singbox 节点')).toBeInTheDocument();
    expect(await screen.findByText('KEEP-HK')).toBeInTheDocument();
    // 探测列:有结果 → 通;hover 才显示延迟
    expect(await screen.findByText('通')).toBeInTheDocument();
    // 端口与入口机来自接口,不该是 undefined
    expect(screen.getByText('30001')).toBeInTheDocument();
    expect(screen.getAllByText('HK1').length).toBeGreaterThan(0);
  });
});
