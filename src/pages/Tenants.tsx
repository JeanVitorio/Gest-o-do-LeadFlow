import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Building2, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge } from '../components/StatusBadge'
import { platformApi } from '../services/platform'

export default function Tenants() {
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [plan, setPlan] = useState('')
  const [tenantStatus, setTenantStatus] = useState('')
  const [subscriptionStatus, setSubscriptionStatus] = useState(
    searchParams.get('subscription_status') ?? '',
  )
  const [page, setPage] = useState(1)

  const tenants = useQuery({
    queryKey: ['tenants', query, plan, tenantStatus, subscriptionStatus, page],
    queryFn: () =>
      platformApi.searchTenants({
        query,
        plan_code: plan,
        tenant_status: tenantStatus,
        subscription_status: subscriptionStatus,
        page,
      }),
    placeholderData: (previous) => previous,
  })

  const totalPages = tenants.data ? Math.max(1, Math.ceil(tenants.data.total / 20)) : 1

  return (
    <div className="page-container">
      <PageHeader
        eyebrow="BASE DE CLIENTES"
        title="Empresas"
        description="Pesquise, acompanhe e administre todas as contas da plataforma."
      />

      <section className="panel table-panel">
        <div className="filters-bar">
          <div className="search-field">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(1)
              }}
              placeholder="Nome, e-mail, slug ou ID Stripe..."
              aria-label="Pesquisar empresas"
            />
          </div>
          <select
            value={plan}
            onChange={(event) => {
              setPlan(event.target.value)
              setPage(1)
            }}
            aria-label="Filtrar por plano"
          >
            <option value="">Todos os planos</option>
            <option value="free">Free</option>
            <option value="basic">Básico</option>
            <option value="plus">Plus</option>
            <option value="pro">Pro</option>
          </select>
          <select
            value={tenantStatus}
            onChange={(event) => {
              setTenantStatus(event.target.value)
              setPage(1)
            }}
            aria-label="Filtrar por status da empresa"
          >
            <option value="">Todas as empresas</option>
            <option value="active">Ativas</option>
            <option value="suspended">Suspensas</option>
            <option value="closed">Encerradas</option>
          </select>
          <select
            value={subscriptionStatus}
            onChange={(event) => {
              setSubscriptionStatus(event.target.value)
              setPage(1)
            }}
            aria-label="Filtrar por assinatura"
          >
            <option value="">Todas as assinaturas</option>
            <option value="active">Em dia</option>
            <option value="trialing">Em teste</option>
            <option value="past_due">Inadimplentes</option>
            <option value="canceled">Canceladas</option>
          </select>
        </div>

        {tenants.isLoading ? (
          <TableLoading />
        ) : tenants.isError ? (
          <div className="table-message">
            {tenants.error instanceof Error ? tenants.error.message : 'Falha ao carregar empresas.'}
          </div>
        ) : tenants.data?.items.length === 0 ? (
          <div className="table-empty">
            <Building2 size={30} />
            <h3>Nenhuma empresa encontrada</h3>
            <p>Ajuste os filtros ou pesquise por outro termo.</p>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Empresa</th>
                    <th>Plano</th>
                    <th>Assinatura</th>
                    <th>Leads</th>
                    <th>Usuários</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tenants.data?.items.map((tenant) => (
                    <tr key={tenant.tenant_id}>
                      <td>
                        <div className="entity-cell">
                          <span className="entity-avatar">{tenant.name.slice(0, 2).toUpperCase()}</span>
                          <div>
                            <strong>{tenant.name}</strong>
                            <small>{tenant.owner_email ?? tenant.slug}</small>
                          </div>
                        </div>
                      </td>
                      <td><StatusBadge value={tenant.plan_code} /></td>
                      <td>
                        <div className="stacked-badges">
                          <StatusBadge value={tenant.subscription_status} />
                          {tenant.tenant_status !== 'active' && (
                            <StatusBadge value={tenant.tenant_status} />
                          )}
                        </div>
                      </td>
                      <td>
                        <Usage value={tenant.leads_used} limit={tenant.leads_limit} />
                      </td>
                      <td>{tenant.users_used}/{tenant.user_limit}</td>
                      <td>
                        <Link
                          className="row-action"
                          to={`/empresas/${tenant.tenant_id}`}
                          aria-label={`Abrir ${tenant.name}`}
                        >
                          <ArrowRight size={18} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <footer className="table-footer">
              <span>
                {tenants.data?.total.toLocaleString('pt-BR')} empresa(s)
              </span>
              <div className="pagination">
                <button
                  className="icon-button"
                  disabled={page === 1}
                  onClick={() => setPage((current) => current - 1)}
                >
                  <ChevronLeft size={18} />
                </button>
                <span>{page} de {totalPages}</span>
                <button
                  className="icon-button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  )
}

function Usage({ value, limit }: { value: number; limit: number }) {
  const percentage = limit ? Math.min(100, Math.round((value / limit) * 100)) : 0
  return (
    <div className="usage-cell">
      <span>{value.toLocaleString('pt-BR')} / {limit.toLocaleString('pt-BR')}</span>
      <div className="mini-progress"><i style={{ width: `${percentage}%` }} /></div>
    </div>
  )
}

function TableLoading() {
  return (
    <div className="table-loading">
      {Array.from({ length: 6 }).map((_, index) => (
        <div className="skeleton skeleton-row" key={index} />
      ))}
    </div>
  )
}
