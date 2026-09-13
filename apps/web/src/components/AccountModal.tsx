import { useEffect, useState } from 'react';
import { App, Form, Input, Modal } from 'antd';
import * as api from '../services/api';

interface AccountModalProps {
  open: boolean;
  onClose: () => void;
  onChanged: (username: string) => void;
}

interface FormValues {
  username: string;
  oldPassword: string;
  newPassword?: string;
}

/** 管理员账号/密码在线修改(需验证旧密码) */
export function AccountModal({ open, onClose, onChanged }: AccountModalProps) {
  const [form] = Form.useForm<FormValues>();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    api
      .getMe()
      .then((me) => form.setFieldsValue({ username: me.username }))
      .catch(() => undefined);
  }, [open, form]);

  const handleOk = async () => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      const res = await api.updateAccount({
        username: values.username.trim(),
        oldPassword: values.oldPassword,
        newPassword: values.newPassword,
      });
      message.success('账号已更新');
      onChanged(res.username);
      onClose();
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title="修改管理员账号"
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      maskClosable={false}
      destroyOnHidden
      onOk={handleOk}
      onCancel={onClose}
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item name="oldPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新密码(留空不修改)"
          rules={[{ min: 6, message: '至少 6 位' }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
