import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './components/layout/AppLayout'
import { useAuth } from './context/AuthContext'
import Dashboard from './pages/Dashboard'
import Login from './pages/Login'
import NotFound from './pages/NotFound'
import PasswordRecovery from './pages/PasswordRecovery'
import ResetPassword from './pages/ResetPassword'
import TenantDetail from './pages/TenantDetail'
import Tenants from './pages/Tenants'
import Users from './pages/Users'

function ProtectedLayout() {
  const { ready, authorized } = useAuth()
  if (!ready) return <div className="boot-screen"><span className="boot-loader" /></div>
  if (!authorized) return <Navigate to="/login" replace />
  return <AppLayout />
}

function OperatorRoute({ children }: { children: ReactNode }) {
  const { role } = useAuth()
  if (role === 'viewer') return <Navigate to="/" replace />
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/esqueci-a-senha" element={<PasswordRecovery />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<ProtectedLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="empresas" element={<Tenants />} />
        <Route path="empresas/:tenantId" element={<TenantDetail />} />
        <Route
          path="usuarios"
          element={<OperatorRoute><Users /></OperatorRoute>}
        />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
