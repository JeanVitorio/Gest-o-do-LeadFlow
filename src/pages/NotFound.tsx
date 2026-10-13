import { ArrowLeft } from 'lucide-react'
import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <main className="simple-auth-page">
      <section className="empty-state panel">
        <span className="error-code">404</span>
        <h1>Página não encontrada</h1>
        <p>O endereço acessado não existe neste painel.</p>
        <Link className="primary-button" to="/"><ArrowLeft size={16} /> Voltar ao painel</Link>
      </section>
    </main>
  )
}
