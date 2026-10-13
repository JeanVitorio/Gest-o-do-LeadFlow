import { supabase } from '../integrations/supabase/client'
import type {
  ApiEnvelope,
  GlobalMetrics,
  PaginatedUsers,
  PlanCode,
  PlatformRole,
  TenantDetail,
  TenantSearchResult,
  TenantStatus,
} from '../types/platform'

export class PlatformApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(
    message: string,
    status = 500,
    code = 'UNKNOWN',
  ) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function invoke<T>(
  functionName: string,
  body: Record<string, unknown>,
  requestId: string = crypto.randomUUID(),
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<ApiEnvelope<T>>(functionName, {
    body,
    headers: { 'x-request-id': requestId },
  })

  if (error) {
    let message = error.message || 'Não foi possível concluir a operação.'
    let code = 'FUNCTION_ERROR'
    let status = 500

    if ('context' in error && error.context instanceof Response) {
      status = error.context.status
      const payload = (await error.context.clone().json().catch(() => null)) as {
        error?: string
        code?: string
      } | null
      message = payload?.error || message
      code = payload?.code || code
    }

    throw new PlatformApiError(message, status, code)
  }

  if (!data?.ok) {
    throw new PlatformApiError(data?.error || 'Operação recusada.', 400, data?.code ?? 'UNKNOWN')
  }

  return data.data
}

export const platformApi = {
  metrics: () => invoke<GlobalMetrics>('admin-metrics', {}),

  searchTenants: (params: {
    query?: string
    plan_code?: string
    tenant_status?: string
    subscription_status?: string
    page?: number
    page_size?: number
  }) =>
    invoke<TenantSearchResult>('admin-tenants', {
      action: 'search',
      query: params.query || '',
      filters: {
        plan_code: params.plan_code || undefined,
        tenant_status: params.tenant_status || undefined,
        subscription_status: params.subscription_status || undefined,
      },
      page: params.page || 1,
      page_size: params.page_size || 20,
    }),

  tenantDetail: (tenantId: string) =>
    invoke<TenantDetail>('admin-tenants', { action: 'get', tenant_id: tenantId }),

  updateTenant: (
    tenantId: string,
    patch: { name?: string; slug?: string; status?: TenantStatus },
    reason: string,
    requestId?: string,
  ) =>
    invoke<{ tenant_id: string }>('admin-tenants', {
      action: 'update',
      tenant_id: tenantId,
      patch,
      reason,
    }, requestId),

  searchUsers: (params: {
    query?: string
    tenant_id?: string
    page?: number
    page_size?: number
  }) =>
    invoke<PaginatedUsers>('admin-users', {
      action: 'search',
      query: params.query || '',
      tenant_id: params.tenant_id || undefined,
      page: params.page || 1,
      page_size: params.page_size || 20,
    }),

  updateUser: (
    userId: string,
    tenantId: string,
    patch: {
      name?: string
      position?: string
      phone?: string
      tenant_role?: 'admin' | 'member'
    },
    reason: string,
    requestId?: string,
  ) =>
    invoke<{ user_id: string }>('admin-users', {
      action: 'update',
      user_id: userId,
      tenant_id: tenantId,
      patch,
      reason,
    }, requestId),

  setUserBlocked: (
    userId: string,
    tenantId: string,
    blocked: boolean,
    reason: string,
    requestId?: string,
  ) =>
    invoke<{ user_id: string }>('admin-users', {
      action: blocked ? 'block' : 'unblock',
      user_id: userId,
      tenant_id: tenantId,
      reason,
    }, requestId),

  changePlan: (
    tenantId: string,
    planCode: Exclude<PlanCode, 'free'>,
    reason: string,
    prorationBehavior: 'create_prorations' | 'none',
    requestId?: string,
  ) =>
    invoke<{ mode: 'updated' | 'checkout_required'; checkout_url?: string }>(
      'admin-billing-stripe',
      {
        action: 'change_plan',
        tenant_id: tenantId,
        plan_code: planCode,
        reason,
        proration_behavior: prorationBehavior,
      },
      requestId,
    ),

  cancelSubscription: (
    tenantId: string,
    mode: 'at_period_end' | 'immediate',
    reason: string,
    requestId?: string,
  ) =>
    invoke<{ stripe_subscription_id: string }>('admin-billing-stripe', {
      action: 'cancel_subscription',
      tenant_id: tenantId,
      mode,
      reason,
    }, requestId),

  grantManualPayment: (
    tenantId: string,
    planCode: PlanCode,
    validUntil: string,
    reason: string,
    requestId?: string,
  ) =>
    invoke<{ grant_id: string }>('admin-billing-ops', {
      action: 'grant_manual_payment',
      tenant_id: tenantId,
      plan_code: planCode,
      valid_until: validUntil,
      reason,
    }, requestId),

  revokeManualPayment: (
    tenantId: string,
    grantId: string,
    reason: string,
    requestId?: string,
  ) =>
    invoke<{ grant_id: string; revoked: boolean }>('admin-billing-ops', {
      action: 'revoke_manual_payment',
      tenant_id: tenantId,
      grant_id: grantId,
      reason,
    }, requestId),

  adjustQuota: (
    tenantId: string,
    quantity: number,
    reason: string,
    requestId?: string,
  ) =>
    invoke<{
      leads_used_before: number
      leads_used_after: number
      leads_limit: number
    }>('admin-billing-ops', {
      action: 'adjust_quota',
      tenant_id: tenantId,
      quantity,
      reason,
      idempotency_key: requestId ?? crypto.randomUUID(),
    }, requestId),

  role: () => invoke<{ role: PlatformRole }>('admin-metrics', { action: 'identity' }),
}
