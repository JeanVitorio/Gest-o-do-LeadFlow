import { useState } from 'react'
import { ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react'
import { Link, Navigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Logo } from '../components/Logo'
import { useAuth } from '../context/AuthContext'

export default function Login() {
  const { login, authorized, ready } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)

  if (ready && authorized) return <Navigate to="/" replace />

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await login(email, password)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível entrar.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-story">
        <Logo />
        <div className="auth-story-content">
          <span className="eyebrow">CENTRAL DE OPERAÇÕES</span>
          <h1>Todo o seu SaaS.<br />Uma única visão.</h1>
          <p>
            Empresas, assinaturas e usuários reunidos em uma central segura para decisões rápidas.
          </p>
          <div className="security-note">
            <ShieldCheck size={22} />
            <div>
              <strong>Acesso administrativo protegido</strong>
              <span>Toda alteração sensível é autenticada e auditada.</span>
            </div>
          </div>
        </div>
        <div className="auth-glow" />
      </section>

      <section className="auth-form-side">
        <form className="auth-form" onSubmit={submit}>
          <div className="auth-form-icon"><LockKeyhole size={22} /></div>
          <span className="eyebrow">BEM-VINDO DE VOLTA</span>
          <h2>Entre no Command Center</h2>
          <p>Use sua conta administrativa autorizada no Supabase.</p>

          <label>
            E-mail
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              placeholder="voce@jvstech.com.br"
              required
            />
          </label>
          <label>
            Senha
            <div className="password-field">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="Sua senha"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </label>

          <Link className="forgot-link" to="/esqueci-a-senha">Esqueci minha senha</Link>
          <button className="primary-button full-button" disabled={busy}>
            {busy ? 'Verificando acesso...' : 'Entrar com segurança'}
            {!busy && <ArrowRight size={18} />}
          </button>
          <small className="auth-footnote">
            Não existe cadastro público. O acesso é liberado por um administrador da plataforma.
          </small>
        </form>
      </section>
    </main>
  )
}
