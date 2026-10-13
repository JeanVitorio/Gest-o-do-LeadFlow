import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Modal } from '../Modal'
import { platformApi } from '../../services/platform'
import type { TenantDetail, TenantStatus } from '../../types/platform'

export function TenantEditModal({
  detail,
  open,
  onClose,
}: {
  detail: TenantDetail
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(detail.tenant.name)
  const [slug, setSlug] = useState(detail.tenant.slug)
  const [status, setStatus] = useState<TenantStatus>(detail.tenant.status)
  const [reason, setReason] = useState('')
  const [requestId] = useState(() => crypto.randomUUID())

  const mutation = useMutation({
    mutationFn: () =>
      platformApi.updateTenant(detail.tenant.id, { name, slug, status }, reason, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tenant', detail.tenant.id] })
      await queryClient.invalidateQueries({ queryKey: ['tenants'] })
      toast.success('Empresa atualizada e ação registrada.')
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (reason.trim().length < 10) {
      return toast.error('Informe um motivo com pelo menos 10 caracteres.')
    }
    mutation.mutate()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Editar empresa"
      description="Mudanças de status afetam o acesso operacional desta empresa."
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            Nome
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Slug
            <input value={slug} onChange={(event) => setSlug(event.target.value)} required />
          </label>
        </div>
        <label>
          Status da empresa
          <select value={status} onChange={(event) => setStatus(event.target.value as TenantStatus)}>
            <option value="active">Ativa</option>
            <option value="suspended">Suspensa</option>
            <option value="closed">Encerrada</option>
          </select>
        </label>
        <label>
          Motivo da alteração
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Explique por que esta alteração está sendo feita..."
            minLength={10}
            required
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancelar</button>
          <button className="primary-button" disabled={mutation.isPending}>
            {mutation.isPending ? 'Salvando...' : 'Salvar alteração'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
