import { ShieldCheck } from 'lucide-react'

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="Gestão LeadFlow">
      <span className="brand-mark">
        <ShieldCheck size={21} strokeWidth={2.4} />
      </span>
      {!compact && (
        <span className="brand-copy">
          <strong>LeadFlow</strong>
          <small>Command Center</small>
        </span>
      )}
    </div>
  )
}
