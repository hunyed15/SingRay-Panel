import { Modal } from 'antd';
import type { SniItem } from '../services/types';
import { SniLibraryCard } from './SniLibraryCard';

interface SniLibraryModalProps {
  open: boolean;
  snis: SniItem[];
  onClose: () => void;
  onChanged: () => void;
}

/** 节点页快捷入口:复用设置页的域名库管理卡片,以弹窗形式呈现 */
export function SniLibraryModal({ open, snis, onClose, onChanged }: SniLibraryModalProps) {
  return (
    <Modal open={open} title="Reality 域名库" footer={null} width={720} onCancel={onClose}>
      <SniLibraryCard snis={snis} onChanged={onChanged} />
    </Modal>
  );
}
