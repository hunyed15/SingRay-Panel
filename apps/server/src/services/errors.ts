// 带 HTTP 状态码的业务错误;由全局 errorHandler 转成 { error: message }
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
