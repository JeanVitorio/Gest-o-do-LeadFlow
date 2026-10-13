export type PlatformRole = 'viewer' | 'operator' | 'billing'
export type TenantStatus = 'active' | 'suspended' | 'closed'
export type PlanCode = 'free' | 'basic' | 'plus' | 'pro'

export interface GlobalMetrics {
  tenants_total: number
  tenants_active: number
  tenants_suspended: number
  users_total: number
  subscriptions_active: number
  subscriptions_past_due: number
  mrr_estimate_cents: number
  leads_used_month: number
  subscriptions_by_plan: Record<PlanCode, number>
  subscriptions_by_status: Record<string, number>
}

export interface TenantSummary {
  tenant_id: string
  name: string
  slug: string
  tenant_status: TenantStatus
  plan_code: PlanCode
  subscription_status: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  leads_used: number
  leads_limit: number
  users_used: number
  user_limit: number
  owner_email: string | null
  created_at: string
}

export interface TenantSearchResult {
  items: TenantSummary[]
  page: number
  page_size: number
  total: number
}

export interface TenantMember {
  user_id: string
  email: string | null
  name: string
  position: string | null
  phone: string | null
  is_active: boolean
  tenant_role: 'owner' | 'admin' | 'member'
  last_sign_in_at: string | null
}

export interface AuditEntry {
  id: number
  actor_email: string | null
  action: string
  reason: string
  created_at: string
  payload_before: unknown
  payload_after: unknown
}

export interface BillingGrant {
  id: string
  grant_type: 'manual_payment' | 'billing_exempt'
  plan_code: PlanCode
  valid_from: string
  valid_until: string
  reason: string
  revoked_at: string | null
}

export interface TenantDetail {
  tenant: {
    id: string
    name: string
    slug: string
    status: TenantStatus
    stripe_customer_id: string | null
    created_at: string
  }
  subscription: {
    plan_code: PlanCode
    status: string
    stripe_subscription_id: string | null
    current_period_start: string
    current_period_end: string
    cancel_at_period_end: boolean
  }
  usage: {
    leads_used: number
    leads_limit: number
    period_start: string
    period_end: string
  }
  members: TenantMember[]
  grants: BillingGrant[]
  recent_audit: AuditEntry[]
  stripe: {
    customer_email: string | null
    latest_invoices: Array<{
      id: string
      status: string
      amount_due: number
      hosted_invoice_url: string | null
    }>
  } | null
}

export interface PlatformUser {
  user_id: string
  email: string
  name: string
  is_active: boolean
  tenant_id: string
  tenant_name: string
  tenant_role: 'owner' | 'admin' | 'member'
  position: string | null
  phone: string | null
  last_sign_in_at: string | null
}

export interface PaginatedUsers {
  items: PlatformUser[]
  page: number
  page_size: number
  total: number
}

export type ApiEnvelope<T> =
  | {
      ok: true
      request_id: string
      data: T
    }
  | {
      ok: false
      request_id: string
      error: string
      code?: string
    }
