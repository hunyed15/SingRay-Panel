import React from 'react';
import { Alert, Button, Card, Typography } from 'antd';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/** 全局错误边界:渲染异常不再白屏(antd 卡片呈现 + 返回首页) */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[SingRayPanel] render error:', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Card style={{ margin: 24 }}>
          <Alert
            type="error"
            showIcon
            message="页面渲染出错"
            description={
              <Typography.Text code style={{ whiteSpace: 'pre-wrap' }}>
                {this.state.error.message}
              </Typography.Text>
            }
            action={
              <Button
                onClick={() => {
                  this.setState({ error: null });
                  window.location.hash = '';
                  window.location.href = '/servers';
                }}
              >
                返回服务器页
              </Button>
            }
          />
        </Card>
      );
    }
    return this.props.children;
  }
}
