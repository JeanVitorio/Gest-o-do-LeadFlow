const statusLabels: Record<string, string> = {
  active: 'Ativo',
  trialing: 'Em teste',
  past_due: 'Inadimplente',
  canceled: 'Cancelado',
  incomplete: 'Incompleto',
  suspended: 'Suspensa',
  closed: 'Encerrada',
  free: 'Free',
  basic: 'Básico',
  plus: 'Plus',
  pro: 'Pro',
}

export function StatusBadge({ value }: { value: string }) {
  const tone = ['active', 'trialing'].includes(value)
    ? 'positive'
    : ['past_due', 'suspended', 'incomplete'].includes(value)
      ? 'warning'
      : ['canceled', 'closed'].includes(value)
        ? 'negative'
        : 'neutral'

  return <span className={`status-badge badge-${tone}`}>{statusLabels[value] ?? value}</span>
}
