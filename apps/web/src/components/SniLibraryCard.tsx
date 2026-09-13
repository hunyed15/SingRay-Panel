import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Flex,
  Form,
  Input,
  Popconfirm,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../services/api';
import type { SniItem } from '../services/types';

interface SniLibraryCardProps {
  snis: SniItem[];
  onChanged: () => void;
}

interface AddForm {
  domain: string;
  note: string;
}

/**
 * Reality 借站域名库管理(设置页内嵌卡片):内置大厂域名 + 用户可加/编辑/删除。
 * 新建 VLESS+Reality / ShadowTLS 节点时从本库选择 SNI。
 */
export function SniLibraryCard({ snis, onChanged }: SniLibraryCardProps) {
  const { message } = App.useApp();
  const [addForm] = Form.useForm<AddForm>();
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDomain, setEditDomain] = useState('');
  const [editNote, setEditNote] = useState('');

  const handleAdd = async (values: AddForm) => {
    setAdding(true);
    try {
      await api.createSni(values.domain.trim(), values.note);
      addForm.resetFields();
      message.success('已添加');
      onChanged();
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (row: SniItem) => {
    setEditingId(row.id);
    setEditDomain(row.domain);
    setEditNote(row.note);
  };

  const cancelEdit = () => setEditingId(null);

  const saveEdit = async () => {
    if (editingId === null) return;
    setSaving(true);
    try {
      await api.updateSni(editingId, { domain: editDomain.trim(), note: editNote });
      message.success('已保存');
      setEditingId(null);
      onChanged();
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row: SniItem) => {
    try {
      await api.deleteSni(row.id);
      message.success(`已删除 ${row.domain}`);
      onChanged();
    } catch {
      // 错误提示由 api 层统一弹出
    }
  };

  const columns: ColumnsType<SniItem> = [
    {
      title: '域名',
      dataIndex: 'domain',
      render: (_, row) =>
        editingId === row.id ? (
          <Input
            value={editDomain}
            onChange={(e) => setEditDomain(e.target.value)}
            style={{ width: 220 }}
          />
        ) : (
          <Flex align="center" gap={8}>
            <Typography.Text code>{row.domain}</Typography.Text>
            {row.builtin === 1 && <Tag>内置</Tag>}
          </Flex>
        ),
    },
    {
      title: '备注',
      dataIndex: 'note',
      width: 200,
      render: (value: string, row) =>
        editingId === row.id ? (
          <Input value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="用途说明" />
        ) : (
          <Typography.Text type="secondary">{value || '-'}</Typography.Text>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_, row) =>
        editingId === row.id ? (
          <Flex gap={4}>
            <Button type="link" loading={saving} onClick={saveEdit}>
              保存
            </Button>
            <Button type="link" onClick={cancelEdit}>
              取消
            </Button>
          </Flex>
        ) : (
          <Flex gap={4}>
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => startEdit(row)}>
              编辑
            </Button>
            <Popconfirm
              title={`删除域名 ${row.domain}?`}
              description="删除后新建 Reality 节点时将不再可选;已在用该域名的节点不受影响。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => handleDelete(row)}
            >
              <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          </Flex>
        ),
    },
  ];

  return (
    <Card title="Reality 借站域名库">
      <Flex vertical gap={16}>
        <Typography.Text type="secondary">
          Reality 节点「借站」这些大厂域名握手,无需自己的证书。新建 VLESS+Reality / ShadowTLS
          节点时可从中选择;内置域名也可编辑/删除。
        </Typography.Text>

        <Form<AddForm> form={addForm} layout="inline" onFinish={handleAdd}>
          <Form.Item
            name="domain"
            rules={[
              { required: true, message: '请输入域名' },
              { pattern: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i, message: '域名格式不正确' },
            ]}
          >
            <Input placeholder="www.example.com" style={{ width: 240 }} />
          </Form.Item>
          <Form.Item name="note">
            <Input placeholder="备注(可选)" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />} loading={adding}>
              添加
            </Button>
          </Form.Item>
        </Form>

        <Table<SniItem>
          rowKey="id"
          columns={columns}
          dataSource={snis}
          pagination={false}
          size="small"
          locale={{ emptyText: '域名库为空,请先添加' }}
        />
      </Flex>
    </Card>
  );
}
