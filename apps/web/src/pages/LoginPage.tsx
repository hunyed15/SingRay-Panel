import { useState } from 'react';
import { App, Button, Card, Flex, Form, Input, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import * as api from '../services/api';

interface FormValues {
  username: string;
  password: string;
}

/** 登录页:POST /api/auth/login,token 存 localStorage(后续请求统一带 Bearer) */
export function LoginPage() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: FormValues) => {
    setLoading(true);
    try {
      const res = await api.login(values.username.trim(), values.password);
      message.success(`欢迎回来,${res.username}`);
      navigate('/', { replace: true });
    } catch {
      // 登录失败(如用户名或密码错误)已由 api 层统一弹错
    } finally {
      setLoading(false);
    }
  };

  return (
    <Flex align="center" justify="center" style={{ minHeight: '100vh', background: '#f5f5f5' }}>
      <Card title="SingRay 面板登录" style={{ width: 380 }}>
        <Form<FormValues> layout="vertical" onFinish={onFinish} autoComplete="off">
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input autoFocus autoComplete="username" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
          SingBox + Xray 双核心节点管理面板
        </Typography.Text>
      </Card>
    </Flex>
  );
}
