import { useEffect, useState } from 'react';
import { Button, Flex, Layout, Menu, Typography, theme } from 'antd';
import {
  ApiOutlined,
  ClusterOutlined,
  LogoutOutlined,
  SettingOutlined,
  ShareAltOutlined,
  UserOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { clearToken } from '../services/auth';
import * as api from '../services/api';
import { AccountModal } from '../components/AccountModal';

const { Sider, Header, Content } = Layout;

const NAV_ITEMS = [
  { key: '/servers', icon: <ClusterOutlined />, label: '服务器' },
  { key: '/nodes', icon: <ApiOutlined />, label: 'Singbox 节点' },
  { key: '/xray-nodes', icon: <ShareAltOutlined />, label: 'Xray 节点' },
  { key: '/port-forwards', icon: <ShareAltOutlined />, label: '中转规则' },
  { key: '/certificates', icon: <SafetyCertificateOutlined />, label: '证书管理' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' },
];
const NAV_KEYS = NAV_ITEMS.map((item) => item.key);

/** 主应用布局:侧边导航(服务器/节点/Xray 节点/中转规则/设置)+ Header + Content */
export function MainLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { token } = theme.useToken();
  const [accountOpen, setAccountOpen] = useState(false);
  const [username, setUsername] = useState('');

  const selectedKey = NAV_KEYS.find((key) => pathname.startsWith(key)) ?? '/servers';

  useEffect(() => {
    let cancelled = false;
    api
      .getMe()
      .then((me) => {
        if (!cancelled) setUsername(me.username);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = () => {
    clearToken();
    navigate('/login', { replace: true });
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={200} theme="dark">
        <Flex align="center" style={{ height: 64, padding: '0 16px' }}>
          <Typography.Text strong style={{ color: token.colorTextLightSolid, fontSize: 16 }}>
            SingRay 面板
          </Typography.Text>
        </Flex>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={NAV_ITEMS}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: token.colorBgContainer,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 8,
            paddingInline: 24,
          }}
        >
          {username && <Typography.Text type="secondary">{username}</Typography.Text>}
          <Button type="text" icon={<UserOutlined />} onClick={() => setAccountOpen(true)}>
            修改账号
          </Button>
          <Button type="text" icon={<LogoutOutlined />} onClick={handleLogout}>
            退出登录
          </Button>
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
      <AccountModal
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        onChanged={(name) => setUsername(name)}
      />
    </Layout>
  );
}
