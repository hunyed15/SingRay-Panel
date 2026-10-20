// 带 HTTP 状态码 + 机器可读 code 的业务错误。
// code 让前端能区分"会话过期"和"这次登录的账号密码错了"这类同状态码的语义
// (旧实现是拿中文/英文 error 字符串做控制流)。

export type ErrorCode =
  | 'bad_request'
  | 'invalid_credentials'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'upstream_failed'
  | 'internal';

const DEFAULT_CODE: Record<number, ErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
  502: 'upstream_failed',
};

/** 状态码 → 默认 code(5xx 一律 internal) */
export function codeForStatus(status: number): ErrorCode {
  return DEFAULT_CODE[status] ?? (status >= 500 ? 'internal' : 'bad_request');
}

export class HttpError extends Error {
  readonly code: ErrorCode;

  constructor(
    public readonly status: number,
    message: string,
    code?: ErrorCode,
  ) {
    super(message);
    this.name = 'HttpError';
    this.code = code ?? codeForStatus(status);
  }
}
