import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Navigate, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Logo } from '../components/Logo'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../integrations/supabase/client'

export default function ResetPassword() {
  const navigate = useNavigate()
  const { ready, recoveryMode } = useAuth()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)

  if (!ready) return <div className="boot-screen"><span className="boot-loader" /></div>
  if (!recoveryMode) return <Navigate to="/login" replace />

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (password.length < 8) return toast.error('A senha precisa ter pelo menos 8 caracteres.')
    if (password !== confirmation) return toast.error('As senhas não coincidem.')
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) return toast.error(error.message)
    toast.success('Senha atualizada.')
    navigate('/')
  }

  return (
    <main className="simple-auth-page">
      <form className="auth-form compact-auth" onSubmit={submit}>
        <Logo />
        <div className="auth-form-icon"><KeyRound size={22} /></div>
        <span className="eyebrow">NOVA CREDENCIAL</span>
        <h2>Defina sua nova senha</h2>
        <p>Use pelo menos 8 caracteres e evite senhas reutilizadas.</p>
        <label>
          Nova senha
          <input
            type="password"
            value={password}
            minLength={8}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <label>
          Confirmar senha
          <input
            type="password"
            value={confirmation}
            minLength={8}
            onChange={(event) => setConfirmation(event.target.value)}
            required
          />
        </label>
        <button className="primary-button full-button" disabled={busy}>
          {busy ? 'Atualizando...' : 'Atualizar senha'}
        </button>
      </form>
    </main>
  )
}
