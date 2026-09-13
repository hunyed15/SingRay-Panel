/** token 存取(localStorage);401 过期由 api.ts 统一清理并跳登录 */
export const TOKEN_KEY = 'sr_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
