import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { ServersPage } from './pages/ServersPage';
import { CertificatesPage } from './pages/CertificatesPage';
import { NodesPage } from './pages/NodesPage';
import { XrayNodesPage } from './pages/XrayNodesPage';
import { PortForwardsPage } from './pages/PortForwardsPage';
import { SettingsPage } from './pages/SettingsPage';
import { MainLayout } from './layouts/MainLayout';
import { RequireAuth } from './router/RequireAuth';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <MainLayout />,
        children: [
          { index: true, element: <Navigate to="/servers" replace /> },
          { path: 'servers', element: <ServersPage /> },
          { path: 'nodes', element: <NodesPage /> },
          { path: 'xray-nodes', element: <XrayNodesPage /> },
          { path: 'port-forwards', element: <PortForwardsPage /> },
          { path: 'certificates', element: <CertificatesPage /> },
          { path: 'settings', element: <SettingsPage /> },
        ],
      },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN}>
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
