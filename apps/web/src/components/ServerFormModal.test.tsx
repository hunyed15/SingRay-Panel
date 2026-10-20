// 改角色必须二次确认(D2-05):不会静默重建凭据把订阅链接全废掉。
// 注意 antd 会在两个汉字之间插空格("保 存"),所以按"去掉空白后比较"来定位按钮。
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../services/api', () => ({
  updateServer: vi.fn(async () => ({})),
  createServer: vi.fn(async () => ({})),
}));

import * as api from '../services/api';
import { ServerFormModal } from './ServerFormModal';
import type { Server } from '../services/types';

const record = {
  id: 7,
  name: 'HK1',
  role: 'landing',
  control: 'ssh',
  region: 'HK',
  host: '1.2.3.4',
  clientHost: '',
  sshPort: 22,
  sshUser: 'root',
  sshAuthType: 'password',
  sshSudo: 0,
  ipStack: 'v4',
  portAllow: '',
  jumpServerId: null,
  relayMechanism: 'socat',
  preferViaServerId: null,
} as unknown as Server;

const norm = (s: string) => s.replace(/\s+/g, '');

async function clickButton(user: ReturnType<typeof userEvent.setup>, text: string) {
  const btn = await waitFor(() => {
    const found = Array.from(document.querySelectorAll('button')).find((b) => norm(b.textContent ?? '') === norm(text));
    if (!found) throw new Error(`找不到按钮:${text}`);
    return found;
  });
  await user.click(btn);
}

// antd Select 在 jsdom 里用 user.click 容易卡在指针事件上,用 fireEvent 直接驱动
function changeRole() {
  const selector = document.querySelector('.ant-select-content');
  if (!selector) throw new Error('找不到角色选择框');
  fireEvent.mouseDown(selector);
  fireEvent.click(screen.getByTitle('中转机'));
}

/** 确认弹窗里也有「取消」,必须限定在确认框的按钮组里点 */
async function clickConfirmButton(user: ReturnType<typeof userEvent.setup>, text: string) {
  const btn = await waitFor(() => {
    const group = document.querySelector('.ant-modal-confirm-btns');
    if (!group) throw new Error('确认框未出现');
    const found = Array.from(group.querySelectorAll('button')).find((b) => norm(b.textContent ?? '') === norm(text));
    if (!found) throw new Error(`确认框里找不到按钮:${text}`);
    return found;
  });
  await user.click(btn);
}

const hasConfirmText = () => norm(document.body.textContent ?? '').includes('确认切换角色');

describe('ServerFormModal 改角色', () => {
  it('角色不变 → 直接保存,不弹确认', async () => {
    const user = userEvent.setup();
    render(<ServerFormModal open record={record} onClose={() => {}} onSaved={() => {}} />);

    await clickButton(user, '保存');
    await waitFor(() => expect(api.updateServer).toHaveBeenCalledTimes(1));
    expect(hasConfirmText()).toBe(false);
  });

  it('角色变了 → 先弹确认;取消则不发请求', async () => {
    const user = userEvent.setup();
    render(<ServerFormModal open record={record} onClose={() => {}} onSaved={() => {}} />);

    changeRole();
    await clickButton(user, '保存');

    await waitFor(() => expect(hasConfirmText()).toBe(true));
    await clickConfirmButton(user, '取消');
    // 取消后不发请求就够了(弹窗淡出动画在 jsdom 里不可靠,不断言它消失)
    expect(api.updateServer).not.toHaveBeenCalled();
  });

  it('角色变了并确认 → 带 confirmRotateCredentials 提交', async () => {
    const user = userEvent.setup();
    render(<ServerFormModal open record={record} onClose={() => {}} onSaved={() => {}} />);

    changeRole();
    await clickButton(user, '保存');
    await waitFor(() => expect(hasConfirmText()).toBe(true));
    await clickConfirmButton(user, '确认切换');

    await waitFor(() => expect(api.updateServer).toHaveBeenCalledTimes(1));
    const [id, payload] = vi.mocked(api.updateServer).mock.calls[0] as unknown as [number, Record<string, unknown>];
    expect(id).toBe(7);
    expect(payload.role).toBe('relay');
    expect(payload.confirmRotateCredentials).toBe(true);
  });
});
