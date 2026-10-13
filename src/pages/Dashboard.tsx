import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Building2,
  CircleDollarSign,
  RefreshCw,
  Users,
} from 'lucide-react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { Link } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { platformApi } from '../services/platform'

const planNames = { free: 'Free', basic: 'Básico', plus: 'Plus', pro: 'Pro' }
const planColors = { free: '#64748b', basic: '#38bdf8', plus: '#a78bfa', pro: '#ff6b28' }

const money = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
})

export default function Dashboard() {
  const metrics = useQuery({
    queryKey: ['global-metrics'],
    queryFn: platformApi.metrics,
    refetchInterval: 60_000,
  })

  if (metrics.isLoading) return <DashboardSkeleton />
  if (metrics.isError || !metrics.data) {
    return (
      <div className="page-container">
        <EmptyState
          title="Não foi possível carregar as métricas"
          description={metrics.error instanceof Error ? metrics.error.message : 'Tente novamente.'}
          onRetry={() => void metrics.refetch()}
        />
      </div>
    )
  }

  const data = metrics.data
  const planData = Object.entries(data.subscriptions_by_plan).map(([name, value]) => ({
    name: planNames[name as keyof typeof planNames] ?? name,
    code: name,
    value,
  }))

  return (
    <div className="page-container">
      <PageHeader
        eyebrow="COMMAND CENTER"
        title="Visão geral"
        description="Saúde comercial e operacional de toda a base LeadFlow."
        actions={
          <button className="secondary-button" onClick={() => void metrics.refetch()}>
            <RefreshCw size={16} className={metrics.isFetching ? 'spin' : ''} />
            Atualizar
          </button>
        }
      />

      <section className="stats-grid">
        <StatCard
          label="Empresas"
          value={data.tenants_total.toLocaleString('pt-BR')}
          helper={`${data.tenants_active} em operação`}
          icon={Building2}
        />
        <StatCard
          label="Assinaturas ativas"
          value={data.subscriptions_active.toLocaleString('pt-BR')}
          helper={`${data.subscriptions_past_due} exigem atenção`}
          icon={Activity}
          tone={data.subscriptions_past_due > 0 ? 'warning' : 'success'}
        />
        <StatCard
          label="Receita mensal estimada"
          value={money.format(data.mrr_estimate_cents / 100)}
          helper="Assinaturas ativas e em teste"
          icon={CircleDollarSign}
          tone="success"
        />
        <StatCard
          label="Usuários"
          value={data.users_total.toLocaleString('pt-BR')}
          helper={`${data.leads_used_month.toLocaleString('pt-BR')} leads no ciclo`}
          icon={Users}
        />
      </section>

      <section className="dashboard-grid">
        <article className="panel plan-distribution">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">DISTRIBUIÇÃO</span>
              <h2>Empresas por plano</h2>
            </div>
            <Link to="/empresas" className="text-link">Ver empresas <ArrowRight size={15} /></Link>
          </div>
          <div className="chart-layout">
            <div className="donut-wrap">
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie
                    data={planData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={68}
                    outerRadius={96}
                    paddingAngle={4}
                    stroke="none"
                  >
                    {planData.map((entry) => (
                      <Cell
                        key={entry.code}
                        fill={planColors[entry.code as keyof typeof planColors] ?? '#64748b'}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: '#12151c',
                      border: '1px solid #2a2f3a',
                      borderRadius: 12,
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="donut-center">
                <strong>{data.tenants_total}</strong>
                <span>empresas</span>
              </div>
            </div>
            <div className="chart-legend">
              {planData.map((plan) => (
                <div className="legend-row" key={plan.code}>
                  <span
                    className="legend-dot"
                    style={{ background: planColors[plan.code as keyof typeof planColors] }}
                  />
                  <span>{plan.name}</span>
                  <strong>{plan.value}</strong>
                </div>
              ))}
            </div>
          </div>
        </article>

        <article className="panel attention-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">ATENÇÃO</span>
              <h2>Saúde da operação</h2>
            </div>
          </div>
          <div className="health-list">
            <HealthRow
              label="Empresas suspensas"
              value={data.tenants_suspended}
              tone={data.tenants_suspended ? 'warning' : 'success'}
            />
            <HealthRow
              label="Pagamentos pendentes"
              value={data.subscriptions_past_due}
              tone={data.subscriptions_past_due ? 'danger' : 'success'}
            />
            <HealthRow
              label="Base ativa"
              value={data.tenants_active}
              tone="success"
            />
          </div>
          {data.subscriptions_past_due > 0 && (
            <Link
              to="/empresas?subscription_status=past_due"
              className="attention-callout"
            >
              <AlertTriangle size={19} />
              <span>
                <strong>Existem cobranças que precisam de acompanhamento</strong>
                <small>Abrir empresas inadimplentes</small>
              </span>
              <ArrowRight size={18} />
            </Link>
          )}
        </article>
      </section>
    </div>
  )
}

function HealthRow({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'success' | 'warning' | 'danger'
}) {
  return (
    <div className="health-row">
      <span className={`health-indicator health-${tone}`} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="page-container">
      <div className="skeleton skeleton-title" />
      <div className="stats-grid">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="stat-card skeleton-card" />
        ))}
      </div>
    </div>
  )
}

function EmptyState({
  title,
  description,
  onRetry,
}: {
  title: string
  description: string
  onRetry: () => void
}) {
  return (
    <div className="empty-state panel">
      <AlertTriangle size={28} />
      <h2>{title}</h2>
      <p>{description}</p>
      <button className="primary-button" onClick={onRetry}>Tentar novamente</button>
    </div>
  )
}
