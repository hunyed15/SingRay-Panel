// 页面级 smoke:ServersPage 渲染机器列表 + 待部署横幅
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from 'antd';

const fx = vi.hoisted(() => ({
  server: {
    id: 7,
    name: 'SERVERSMOKE',
    role: 'relay',
    control: 'ssh',
    host: '10.1.2.3',
    clientHost: '',
    sshPort: 22,
    sshUser: 'root',
    sshAuthType: 'password',
    sshSudo: 0,
    region: 'JP',
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
    portAllow: '32679-32699',
  },
}));

vi.mock('../services/api', () => ({
  getServers: vi.fn(async () => [fx.server]),
  getSnis: vi.fn(async () => []),
  getDeployPending: vi.fn(async () => [{ serverId: 7, name: 'SERVERSMOKE', singbox: true, xray: false }]),
  deleteServer: vi.fn(),
  testServer: vi.fn(),
  deployServer: vi.fn(),
  deployServerCore: vi.fn(),
  serverLifecycle: vi.fn(),
  startDeployAll: vi.fn(),
}));

import { ServersPage } from './ServersPage';

describe('ServersPage', () => {
  it('渲染机器行与待部署提示', async () => {
    render(
      <App>
        <ServersPage />
      </App>,
    );
    expect(await screen.findByText('SERVERSMOKE')).toBeInTheDocument();
    expect(screen.getAllByText('10.1.2.3').length).toBeGreaterThan(0);
    // 角色/地区标签来自接口字段
    expect(screen.getAllByText('中转机').length).toBeGreaterThan(0);
    expect(screen.getAllByText('JP').length).toBeGreaterThan(0);
  });
});
