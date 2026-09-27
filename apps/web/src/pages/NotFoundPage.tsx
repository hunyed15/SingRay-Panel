import { Button, Result } from 'antd';
import { useNavigate } from 'react-router-dom';

/** 404 兜底页 */
export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <Result
      status="404"
      title="404"
      subTitle="页面不存在"
      extra={
        <Button type="primary" onClick={() => navigate('/servers')}>
          返回服务器页
        </Button>
      }
    />
  );
}
