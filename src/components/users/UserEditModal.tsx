import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Modal } from '../Modal'
import { platformApi } from '../../services/platform'
import type { PlatformUser, TenantMember } from '../../types/platform'

type EditableUser = PlatformUser | TenantMember

export function UserEditModal({
  user,
  tenantId,
  open,
  onClose,
}: {
  user: EditableUser
  tenantId: string
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(user.name)
  const [position, setPosition] = useState(user.position ?? '')
  const [phone, setPhone] = useState(user.phone ?? '')
  const [role, setRole] = useState<'owner' | 'admin' | 'member'>(user.tenant_role)
  const [reason, setReason] = useState('')
  const [requestId] = useState(() => crypto.randomUUID())

  const mutation = useMutation({
    mutationFn: () => {
      if (role === 'owner' && user.tenant_role !== 'owner') {
        throw new Error('A transferência de proprietário exige um fluxo específico.')
      }
      return platformApi.updateUser(
        user.user_id,
        tenantId,
        {
          name,
          position,
          phone,
          tenant_role: role === 'owner' ? undefined : role,
        },
        reason,
        requestId,
      )
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      if (tenantId) await queryClient.invalidateQueries({ queryKey: ['tenant', tenantId] })
      toast.success('Usuário atualizado.')
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Editar usuário"
      description={user.email ?? "E-mail protegido"}
    >
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (reason.trim().length < 10) {
            return toast.error('Informe um motivo com pelo menos 10 caracteres.')
          }
          mutation.mutate()
        }}
      >
        <div className="form-grid">
          <label>
            Nome
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Papel na empresa
            <select
              value={role}
              disabled={user.tenant_role === 'owner'}
              onChange={(event) =>
                setRole(event.target.value as 'owner' | 'admin' | 'member')
              }
            >
              {user.tenant_role === 'owner' && <option value="owner">Proprietário</option>}
              <option value="admin">Administrador</option>
              <option value="member">Usuário</option>
            </select>
          </label>
          <label>
            Cargo
            <input value={position} onChange={(event) => setPosition(event.target.value)} />
          </label>
          <label>
            Telefone
            <input value={phone} onChange={(event) => setPhone(event.target.value)} />
          </label>
        </div>
        <label>
          Motivo obrigatório
          <textarea
            value={reason}
            minLength={10}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancelar</button>
          <button className="primary-button" disabled={mutation.isPending}>
            {mutation.isPending ? 'Salvando...' : 'Salvar usuário'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
