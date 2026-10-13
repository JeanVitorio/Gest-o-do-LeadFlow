import { useState } from 'react'
import { ArrowLeft, Mail } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Logo } from '../components/Logo'
import { useAuth } from '../context/AuthContext'

export default function PasswordRecovery() {
  const { requestPasswordReset } = useAuth()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await requestPasswordReset(email)
      toast.success('Se a conta existir, você receberá o link de recuperação.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao solicitar recuperação.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="simple-auth-page">
      <form className="auth-form compact-auth" onSubmit={submit}>
        <Logo />
        <div className="auth-form-icon"><Mail size={22} /></div>
        <span className="eyebrow">RECUPERAÇÃO SEGURA</span>
        <h2>Recupere seu acesso</h2>
        <p>Enviaremos um link protegido para o e-mail da conta administrativa.</p>
        <label>
          E-mail
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <button className="primary-button full-button" disabled={busy}>
          {busy ? 'Enviando...' : 'Enviar link'}
        </button>
        <Link className="back-link" to="/login"><ArrowLeft size={16} /> Voltar ao login</Link>
      </form>
    </main>
  )
}
