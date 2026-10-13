import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Ban,
  Building2,
  CalendarDays,
  ExternalLink,
  Gauge,
  Pencil,
  ReceiptText,
  Shield,
  Users,
} from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { BillingActions } from '../components/tenants/BillingActions'
import { TenantEditModal } from '../components/tenants/TenantEditModal'
import { UserEditModal } from '../components/users/UserEditModal'
import { StatusBadge } from '../components/StatusBadge'
import { useAuth } from '../context/AuthContext'
import { PlatformApiError, platformApi } from '../services/platform'
import type { TenantMember } from '../types/platform'

const dateFormatter = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' })
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

export default function TenantDetail() {
  const { tenantId = '' } = useParams()
  const { role } = useAuth()
  const queryClient = useQueryClient()
  const [editingTenant, setEditingTenant] = useState(false)
  const [editingUser, setEditingUser] = useState<TenantMember | null>(null)
  const blockRequestIds = useRef(new Map<string, string>())

  const detail = useQuery({
    queryKey: ['tenant', tenantId],
    queryFn: () => platformApi.tenantDetail(tenantId),
    enabled: Boolean(tenantId),
  })

  const blockMutation = useMutation({
    mutationFn: ({
      user,
      reason,
      requestId,
    }: {
      user: TenantMember
      reason: string
      requestId: string
    }) => platformApi.setUserBlocked(user.user_id, tenantId, user.is_active, reason, requestId),
    onSuccess: async (_data, variables) => {
      blockRequestIds.current.delete(`${variables.user.user_id}:${variables.user.is_active}`)
      await queryClient.invalidateQueries({ queryKey: ['tenant', tenantId] })
      toast.success('Status do usuário atualizado.')
    },
    onError: (error, variables) => {
      if (error instanceof PlatformApiError && error.code === 'FAILED_REPLAY') {
        blockRequestIds.current.delete(`${variables.user.user_id}:${variables.user.is_active}`)
      }
      toast.error(error.message)
    },
  })

  const revokeGrantMutation = useMutation({
    mutationFn: ({ grantId, reason }: { grantId: string; reason: string }) =>
      platformApi.revokeManualPayment(tenantId, grantId, reason),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tenant', tenantId] })
      toast.success('Concessão manual revogada.')
    },
    onError: (error) => toast.error(error.message),
  })

  function toggleBlock(user: TenantMember) {
    const action = user.is_active ? 'bloquear globalmente' : 'desbloquear globalmente'
    const reason = window.prompt(`Informe o motivo para ${action} ${user.name}:`)
    if (!reason) return
    if (reason.trim().length < 10) return toast.error('Use pelo menos 10 caracteres no motivo.')
    const key = `${user.user_id}:${user.is_active}`
    const requestId = blockRequestIds.current.get(key) ?? crypto.randomUUID()
    blockRequestIds.current.set(key, requestId)
    blockMutation.mutate({ user, reason, requestId })
  }

  function revokeGrant(grantId: string) {
    const reason = window.prompt('Informe o motivo para revogar esta concessão manual:')
    if (!reason) return
    if (reason.trim().length < 10) return toast.error('Use pelo menos 10 caracteres no motivo.')
    revokeGrantMutation.mutate({ grantId, reason })
  }

  if (detail.isLoading) {
    return <div className="page-container"><div className="skeleton detail-skeleton" /></div>
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="page-container">
        <Link to="/empresas" className="back-link"><ArrowLeft size={16} /> Voltar</Link>
        <div className="empty-state panel">
          <h2>Empresa não encontrada</h2>
          <p>{detail.error instanceof Error ? detail.error.message : 'Confira o identificador.'}</p>
        </div>
      </div>
    )
  }

  const data = detail.data
  const canOperate = role === 'operator' || role === 'billing'

  return (
    <div className="page-container">
      <Link to="/empresas" className="back-link"><ArrowLeft size={16} /> Empresas</Link>
      <header className="tenant-hero panel">
        <div className="tenant-identity">
          <div className="tenant-logo">{data.tenant.name.slice(0, 2).toUpperCase()}</div>
          <div>
            <div className="tenant-title-line">
              <h1>{data.tenant.name}</h1>
              <StatusBadge value={data.tenant.status} />
              <StatusBadge value={data.subscription.plan_code} />
            </div>
            <p>{data.tenant.slug} · criada em {dateFormatter.format(new Date(data.tenant.created_at))}</p>
          </div>
        </div>
        {canOperate && (
          <button className="secondary-button" onClick={() => setEditingTenant(true)}>
            <Pencil size={16} /> Editar empresa
          </button>
        )}
      </header>

      <section className="detail-stats">
        <DetailStat
          icon={ReceiptText}
          label="Assinatura"
          value={data.subscription.status}
          helper={`Renova em ${dateFormatter.format(new Date(data.subscription.current_period_end))}`}
        />
        <DetailStat
          icon={Gauge}
          label="Leads no ciclo"
          value={`${data.usage.leads_used.toLocaleString('pt-BR')} / ${data.usage.leads_limit.toLocaleString('pt-BR')}`}
          helper={`${Math.max(0, data.usage.leads_limit - data.usage.leads_used).toLocaleString('pt-BR')} restantes`}
        />
        <DetailStat
          icon={Users}
          label="Usuários"
          value={String(data.members.length)}
          helper={`${data.members.filter((member) => member.tenant_role === 'admin').length} administrador(es)`}
        />
        <DetailStat
          icon={Building2}
          label="Stripe Customer"
          value={data.tenant.stripe_customer_id ?? 'Não vinculado'}
          helper={data.subscription.stripe_subscription_id ?? 'Plano sem assinatura Stripe'}
        />
      </section>

      <section className="detail-grid">
        <article className="panel detail-main">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">EQUIPE</span>
              <h2>Usuários da empresa</h2>
            </div>
          </div>
          <div className="members-list">
            {data.members.map((member) => (
              <div className="member-row" key={member.user_id}>
                <span className="entity-avatar">{member.name.slice(0, 2).toUpperCase()}</span>
                <div className="member-copy">
                  <strong>{member.name}</strong>
                  <small>{member.email} · {member.position ?? 'Sem cargo'}</small>
                </div>
                <span className="role-chip">
                  <Shield size={13} /> {member.tenant_role}
                </span>
                <StatusBadge value={member.is_active ? 'active' : 'suspended'} />
                {canOperate && (
                  <div className="row-actions">
                    <button className="icon-button" onClick={() => setEditingUser(member)} title="Editar">
                      <Pencil size={16} />
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => toggleBlock(member)}
                      title={member.is_active ? 'Bloquear acesso global' : 'Desbloquear acesso global'}
                    >
                      <Ban size={16} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </article>

        <aside className="detail-side">
          {canOperate && role && (
            <article className="panel">
              <div className="panel-heading">
                <div><span className="eyebrow">FINANCEIRO</span><h2>Ações administrativas</h2></div>
              </div>
              <BillingActions detail={data} role={role} />
            </article>
          )}

          {role === 'billing' && data.grants.length > 0 && (
            <article className="panel">
              <div className="panel-heading">
                <div><span className="eyebrow">CONCESSÕES</span><h2>Pagamentos manuais</h2></div>
              </div>
              <div className="invoice-list">
                {data.grants.map((grant) => (
                  <div className="grant-row" key={grant.id}>
                    <div>
                      <strong><StatusBadge value={grant.plan_code} /></strong>
                      <small>Válido até {dateFormatter.format(new Date(grant.valid_until))}</small>
                    </div>
                    {!grant.revoked_at ? (
                      <button
                        className="danger-link"
                        onClick={() => revokeGrant(grant.id)}
                        disabled={revokeGrantMutation.isPending}
                      >
                        Revogar
                      </button>
                    ) : (
                      <StatusBadge value="canceled" />
                    )}
                  </div>
                ))}
              </div>
            </article>
          )}

          <article className="panel">
            <div className="panel-heading">
              <div><span className="eyebrow">STRIPE</span><h2>Últimas faturas</h2></div>
            </div>
            <div className="invoice-list">
              {data.stripe?.latest_invoices.length ? (
                data.stripe.latest_invoices.map((invoice) => (
                  <div className="invoice-row" key={invoice.id}>
                    <div>
                      <strong>{money.format(invoice.amount_due / 100)}</strong>
                      <small>{invoice.id}</small>
                    </div>
                    <StatusBadge value={invoice.status} />
                    {invoice.hosted_invoice_url && (
                      <a href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">
                        <ExternalLink size={15} />
                      </a>
                    )}
                  </div>
                ))
              ) : (
                <p className="muted-copy">Nenhuma fatura Stripe disponível.</p>
              )}
            </div>
          </article>
        </aside>
      </section>

      <article className="panel audit-panel">
        <div className="panel-heading">
          <div><span className="eyebrow">AUDITORIA</span><h2>Atividade administrativa recente</h2></div>
        </div>
        <div className="timeline">
          {data.recent_audit.length ? (
            data.recent_audit.map((entry) => (
              <div className="timeline-item" key={entry.id}>
                <span className="timeline-dot"><CalendarDays size={14} /></span>
                <div>
                  <strong>{entry.action}</strong>
                  <p>{entry.reason}</p>
                  <small>
                    {entry.actor_email ?? 'Sistema'} · {dateFormatter.format(new Date(entry.created_at))}
                  </small>
                </div>
              </div>
            ))
          ) : (
            <p className="muted-copy">Nenhuma ação administrativa registrada.</p>
          )}
        </div>
      </article>

      {editingTenant && (
        <TenantEditModal
          detail={data}
          open
          onClose={() => setEditingTenant(false)}
        />
      )}
      {editingUser && (
        <UserEditModal
          user={editingUser}
          tenantId={tenantId}
          open
          onClose={() => setEditingUser(null)}
        />
      )}
    </div>
  )
}

function DetailStat({
  icon: Icon,
  label,
  value,
  helper,
}: {
  icon: typeof ReceiptText
  label: string
  value: string
  helper: string
}) {
  return (
    <article className="detail-stat">
      <Icon size={19} />
      <span>{label}</span>
      <strong title={value}>{value}</strong>
      <small>{helper}</small>
    </article>
  )
}
