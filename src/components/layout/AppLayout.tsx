import { useState } from 'react'
import { Building2, LayoutDashboard, LogOut, Menu, Users, X } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { Logo } from '../Logo'
import { useAuth } from '../../context/AuthContext'

const roleLabels = {
  viewer: 'Visualizador',
  operator: 'Operador',
  billing: 'Administrador financeiro',
}

export function AppLayout() {
  const [open, setOpen] = useState(false)
  const { user, role, logout } = useAuth()

  const nav = [
    { to: '/', label: 'Visão geral', icon: LayoutDashboard, end: true, show: true },
    { to: '/empresas', label: 'Empresas', icon: Building2, show: true },
    { to: '/usuarios', label: 'Usuários', icon: Users, show: role !== 'viewer' },
  ]

  return (
    <div className="app-shell">
      <button
        className="mobile-menu"
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir menu"
      >
        <Menu size={21} />
      </button>
      {open && <button className="sidebar-overlay" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
        <div className="sidebar-top">
          <Logo />
          <button
            className="sidebar-close"
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Fechar menu"
          >
            <X size={18} />
          </button>
        </div>

        <div className="workspace-chip">
          <span className="live-dot" />
          <div>
            <strong>Operação global</strong>
            <small>Ambiente de produção</small>
          </div>
        </div>

        <nav className="sidebar-nav">
          <span className="nav-section">Controle</span>
          {nav
            .filter((item) => item.show)
            .map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={() => setOpen(false)}
                className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
              >
                <Icon size={18} />
                <span>{label}</span>
              </NavLink>
            ))}
        </nav>

        <div className="sidebar-profile">
          <div className="avatar">{user?.email?.slice(0, 2).toUpperCase()}</div>
          <div className="profile-copy">
            <strong>{user?.email}</strong>
            <small>{role ? roleLabels[role] : 'Verificando acesso'}</small>
          </div>
          <button type="button" className="logout-button" onClick={() => void logout()}>
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  )
}
