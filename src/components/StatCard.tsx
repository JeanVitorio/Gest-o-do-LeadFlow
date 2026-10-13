import type { LucideIcon } from 'lucide-react'

export function StatCard({
  label,
  value,
  helper,
  icon: Icon,
  tone = 'default',
}: {
  label: string
  value: string
  helper: string
  icon: LucideIcon
  tone?: 'default' | 'success' | 'warning' | 'danger'
}) {
  return (
    <article className={`stat-card tone-${tone}`}>
      <div className="stat-icon">
        <Icon size={20} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{helper}</small>
      </div>
    </article>
  )
}
