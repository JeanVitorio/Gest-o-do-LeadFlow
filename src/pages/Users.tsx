import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, ChevronLeft, ChevronRight, Pencil, Search, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge } from '../components/StatusBadge'
import { UserEditModal } from '../components/users/UserEditModal'
import { PlatformApiError, platformApi } from '../services/platform'
import type { PlatformUser } from '../types/platform'

export default function Users() {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<PlatformUser | null>(null)
  const [page, setPage] = useState(1)
  const blockRequestIds = useRef(new Map<string, string>())
  const canSearch = query.trim().length >= 3

  const users = useQuery({
    queryKey: ['users', query, page],
    queryFn: () => platformApi.searchUsers({ query, page }),
    enabled: canSearch,
    placeholderData: (previous) => previous,
  })
  const totalPages = users.data ? Math.max(1, Math.ceil(users.data.total / users.data.page_size)) : 1

  const blockMutation = useMutation({
    mutationFn: ({
      user,
      reason,
      requestId,
    }: {
      user: PlatformUser
      reason: string
      requestId: string
    }) =>
      platformApi.setUserBlocked(
        user.user_id,
        user.tenant_id,
        user.is_active,
        reason,
        requestId,
      ),
    onSuccess: async (_data, variables) => {
      blockRequestIds.current.delete(`${variables.user.user_id}:${variables.user.is_active}`)
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('Acesso do usuário atualizado.')
    },
    onError: (error, variables) => {
      if (error instanceof PlatformApiError && error.code === 'FAILED_REPLAY') {
        blockRequestIds.current.delete(`${variables.user.user_id}:${variables.user.is_active}`)
      }
      toast.error(error.message)
    },
  })

  function toggleBlock(user: PlatformUser) {
    const action = user.is_active ? 'bloquear globalmente' : 'desbloquear globalmente'
    const reason = window.prompt(`Informe o motivo para ${action} ${user.name}:`)
    if (!reason) return
    if (reason.trim().length < 10) return toast.error('Informe pelo menos 10 caracteres.')
    const key = `${user.user_id}:${user.is_active}`
    const requestId = blockRequestIds.current.get(key) ?? crypto.randomUUID()
    blockRequestIds.current.set(key, requestId)
    blockMutation.mutate({ user, reason, requestId })
  }

  return (
    <div className="page-container">
      <PageHeader
        eyebrow="GESTÃO DE ACESSO"
        title="Usuários"
        description="Localize e administre usuários de qualquer empresa sem romper o isolamento da base."
      />

      <section className="panel table-panel">
        <div className="user-search-hero">
          <div className="search-field large-search">
            <Search size={19} />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(1)
              }}
              placeholder="Digite nome ou e-mail do usuário..."
              autoFocus
            />
          </div>
          <small>Digite pelo menos 3 caracteres para proteger a privacidade da base.</small>
        </div>

        {!canSearch ? (
          <div className="table-empty">
            <UserRound size={31} />
            <h3>Pesquise um usuário</h3>
            <p>Você poderá editar perfil, papel e status de acesso.</p>
          </div>
        ) : users.isLoading ? (
          <div className="table-loading">
            {Array.from({ length: 5 }).map((_, index) => (
              <div className="skeleton skeleton-row" key={index} />
            ))}
          </div>
        ) : users.isError ? (
          <div className="table-message">
            {users.error instanceof Error ? users.error.message : 'Falha na pesquisa.'}
          </div>
        ) : users.data?.items.length === 0 ? (
          <div className="table-empty"><h3>Nenhum usuário encontrado</h3></div>
        ) : (
          <>
            <div className="table-scroll">
              <table>
              <thead>
                <tr>
                  <th>Usuário</th>
                  <th>Empresa</th>
                  <th>Papel</th>
                  <th>Status</th>
                  <th>Último acesso</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.data?.items.map((user) => (
                  <tr key={`${user.tenant_id}-${user.user_id}`}>
                    <td>
                      <div className="entity-cell">
                        <span className="entity-avatar">{user.name.slice(0, 2).toUpperCase()}</span>
                        <div><strong>{user.name}</strong><small>{user.email}</small></div>
                      </div>
                    </td>
                    <td>{user.tenant_name}</td>
                    <td><span className="role-chip">{user.tenant_role}</span></td>
                    <td><StatusBadge value={user.is_active ? 'active' : 'suspended'} /></td>
                    <td>
                      {user.last_sign_in_at
                        ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(
                            new Date(user.last_sign_in_at),
                          )
                        : 'Nunca'}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button className="icon-button" onClick={() => setSelected(user)} title="Editar">
                          <Pencil size={16} />
                        </button>
                        <button
                          className="icon-button"
                          onClick={() => toggleBlock(user)}
                          title={user.is_active ? 'Bloquear acesso global' : 'Desbloquear acesso global'}
                        >
                          <Ban size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
            <footer className="table-footer">
              <span>{users.data?.total.toLocaleString('pt-BR')} usuário(s)</span>
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

      {selected && (
        <UserEditModal
          user={selected}
          tenantId={selected.tenant_id}
          open
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
