import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { getToken } from '../services/auth';

/** 登录守卫:无 token 跳 /login;401 过期由 api 层统一处理回登录页 */
export function RequireAuth() {
  const token = getToken();
  const location = useLocation();
  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}
