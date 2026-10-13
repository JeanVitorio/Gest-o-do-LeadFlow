import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, CircleDollarSign, Gauge, RefreshCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '../Modal'
import { PlatformApiError, platformApi } from '../../services/platform'
import type { PlanCode, PlatformRole, TenantDetail } from '../../types/platform'

type Action = 'plan' | 'cancel' | 'grant' | 'quota' | null
const today = new Date().toISOString().slice(0, 10)

export function BillingActions({
  detail,
  role,
}: {
  detail: TenantDetail
  role: PlatformRole
}) {
  const [action, setAction] = useState<Action>(null)

  return (
    <>
      <div className="action-grid">
        {role === 'billing' && (
          <button className="action-tile" onClick={() => setAction('plan')}>
            <RefreshCcw size={20} />
            <span><strong>Alterar plano</strong><small>Atualiza a assinatura pela Stripe</small></span>
          </button>
        )}
        {role === 'billing' && (
          <button className="action-tile" onClick={() => setAction('grant')}>
            <CalendarClock size={20} />
            <span><strong>Pagamento manual</strong><small>Concede acesso temporário auditado</small></span>
          </button>
        )}
        <button className="action-tile" onClick={() => setAction('quota')}>
          <Gauge size={20} />
          <span><strong>Ajustar quota</strong><small>Compensa créditos de leads</small></span>
        </button>
        {role === 'billing' && (
          <button className="action-tile danger-tile" onClick={() => setAction('cancel')}>
            <CircleDollarSign size={20} />
            <span><strong>Cancelar assinatura</strong><small>Executa o cancelamento na Stripe</small></span>
          </button>
        )}
      </div>
      <BillingActionModal detail={detail} action={action} onClose={() => setAction(null)} />
    </>
  )
}

function BillingActionModal({
  detail,
  action,
  onClose,
}: {
  detail: TenantDetail
  action: Action
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const requestIds = useRef(new Map<Exclude<Action, null>, string>())
  const [plan, setPlan] = useState<PlanCode>(detail.subscription.plan_code)
  const [reason, setReason] = useState('')
  const [date, setDate] = useState('')
  const [quantity, setQuantity] = useState(100)
  const [cancelMode, setCancelMode] = useState<'at_period_end' | 'immediate'>('at_period_end')
  const [proration, setProration] = useState<'create_prorations' | 'none'>('create_prorations')

  const mutation = useMutation({
    mutationFn: async () => {
      if (!action) throw new Error('Ação inválida.')
      if (reason.trim().length < 10) throw new Error('Informe um motivo com pelo menos 10 caracteres.')
      const requestId = requestIds.current.get(action) ?? crypto.randomUUID()
      requestIds.current.set(action, requestId)

      if (action === 'plan') {
        if (plan === 'free') throw new Error('Para migrar ao Free, cancele a assinatura.')
        return platformApi.changePlan(detail.tenant.id, plan, reason, proration, requestId)
      }
      if (action === 'cancel') {
        return platformApi.cancelSubscription(detail.tenant.id, cancelMode, reason, requestId)
      }
      if (action === 'grant') {
        if (!date) throw new Error('Informe a validade da concessão.')
        return platformApi.grantManualPayment(
          detail.tenant.id,
          plan,
          new Date(`${date}T23:59:59`).toISOString(),
          reason,
          requestId,
        )
      }
      return platformApi.adjustQuota(detail.tenant.id, quantity, reason, requestId)
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['tenant', detail.tenant.id] })
      await queryClient.invalidateQueries({ queryKey: ['global-metrics'] })
      const checkoutUrl =
        action === 'plan' && result && 'checkout_url' in result ? result.checkout_url : null
      if (checkoutUrl) {
        await navigator.clipboard.writeText(String(checkoutUrl))
        toast.success('Link de checkout copiado para você enviar ao cliente.')
      } else {
        toast.success('Operação concluída e registrada.')
      }
      if (action === 'plan' || action === 'cancel') {
        window.setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: ['tenant', detail.tenant.id] })
          void queryClient.invalidateQueries({ queryKey: ['global-metrics'] })
        }, 4_000)
      }
      if (action) requestIds.current.delete(action)
      resetAndClose()
    },
    onError: (error) => {
      if (action && error instanceof PlatformApiError && error.code === 'FAILED_REPLAY') {
        requestIds.current.delete(action)
      }
      toast.error(error.message)
    },
  })

  function resetAndClose() {
    setReason('')
    setDate('')
    setQuantity(100)
    onClose()
  }

  const copy = {
    plan: ['Alterar plano', 'A mudança ocorre na Stripe e chega ao LeadFlow pelo webhook.'],
    cancel: ['Cancelar assinatura', 'Escolha quando o acesso pago deve ser encerrado.'],
    grant: ['Registrar pagamento manual', 'Concessão temporária, com vencimento e trilha de auditoria.'],
    quota: ['Ajustar quota de leads', 'Créditos positivos devolvem leads ao saldo do ciclo atual.'],
  } as const

  if (!action) return null

  return (
    <Modal open title={copy[action][0]} description={copy[action][1]} onClose={resetAndClose}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault()
          mutation.mutate()
        }}
      >
        {action === 'plan' && (
          <>
            <label>
              Novo plano
              <select value={plan} onChange={(event) => setPlan(event.target.value as PlanCode)}>
                <option value="basic">Básico</option>
                <option value="plus">Plus</option>
                <option value="pro">Pro</option>
              </select>
            </label>
            <label>
              Proporcionalidade
              <select
                value={proration}
                onChange={(event) =>
                  setProration(event.target.value as 'create_prorations' | 'none')
                }
              >
                <option value="create_prorations">Calcular valor proporcional</option>
                <option value="none">Sem cobrança proporcional</option>
              </select>
            </label>
          </>
        )}
        {action === 'cancel' && (
          <label>
            Momento do cancelamento
            <select
              value={cancelMode}
              onChange={(event) =>
                setCancelMode(event.target.value as 'at_period_end' | 'immediate')
              }
            >
              <option value="at_period_end">Ao final do período pago</option>
              <option value="immediate">Imediatamente</option>
            </select>
          </label>
        )}
        {action === 'grant' && (
          <div className="form-grid">
            <label>
              Plano concedido
              <select value={plan} onChange={(event) => setPlan(event.target.value as PlanCode)}>
                <option value="basic">Básico</option>
                <option value="plus">Plus</option>
                <option value="pro">Pro</option>
              </select>
            </label>
            <label>
              Válido até
              <input
                type="date"
                value={date}
                min={today}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </label>
          </div>
        )}
        {action === 'quota' && (
          <label>
            Quantidade de leads
            <input
              type="number"
              value={quantity}
              min={-5000}
              max={5000}
              onChange={(event) => setQuantity(Number(event.target.value))}
              required
            />
            <small>Valor positivo devolve saldo; negativo consome saldo.</small>
          </label>
        )}
        <label>
          Motivo obrigatório
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Referência do atendimento, contrato ou justificativa..."
            minLength={10}
            required
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={resetAndClose}>Cancelar</button>
          <button
            className={action === 'cancel' ? 'danger-button' : 'primary-button'}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Processando...' : 'Confirmar operação'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
