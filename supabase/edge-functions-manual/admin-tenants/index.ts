// @ts-nocheck
// Função autocontida para colar em supabase/functions/admin-tenants/index.ts.
import { createClient } from "npm:@supabase/supabase-js@2";

const origins = (Deno.env.get("ADMIN_ALLOWED_ORIGINS") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const tenantStatuses = new Set(["active", "suspended", "closed"]);
const planCodes = new Set(["free", "basic", "plus", "pro"]);
const cors = (req: Request) => ({
  "Access-Control-Allow-Origin": origins.includes(req.headers.get("origin") ?? "") ? req.headers.get("origin")! : "",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-request-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Vary": "Origin",
});
const respond = (req: Request, id: string, status: number, data?: unknown, error?: string, code?: string) =>
  new Response(JSON.stringify(error ? { ok: false, request_id: id, error, code } : { ok: true, request_id: id, data }),
    { status, headers: cors(req) });
const isUuid = (value: unknown) => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function mappedError(error: any, fallback: string) {
  if (error?.status) return { status: error.status, message: error.message, code: error.code ?? "REQUEST_ERROR" };
  if (error?.code === "23505") return { status: 409, message: "Nome ou slug já está em uso", code: "CONFLICT" };
  if (error?.code === "23503") return { status: 409, message: "Operação conflita com dados relacionados", code: "REFERENCE_CONFLICT" };
  if (error?.code === "22P02") return { status: 400, message: "Identificador ou valor inválido", code: "INVALID_INPUT" };
  if (error?.code === "PGRST116") return { status: 404, message: "Empresa não encontrada", code: "NOT_FOUND" };
  if (error?.code === "P0001") {
    const text = String(error.message ?? "").toLowerCase();
    if (text.includes("permissão") || text.includes("acesso negado")) {
      return { status: 403, message: "Perfil sem permissão para esta operação", code: "FORBIDDEN" };
    }
    if (text.includes("não encontrad")) return { status: 404, message: "Empresa não encontrada", code: "NOT_FOUND" };
    if (text.includes("limite") || text.includes("conflit") || text.includes("não pode") || text.includes("já ")) {
      return { status: 409, message: "Operação recusada por conflito de estado", code: "STATE_CONFLICT" };
    }
    return { status: 400, message: "Operação recusada", code: "BUSINESS_RULE" };
  }
  return { status: 500, message: fallback, code: "INTERNAL_ERROR" };
}

async function authorize(req: Request) {
  const token = req.headers.get("authorization");
  if (!token?.match(/^Bearer\s+\S+$/i)) throw { status: 401, message: "Bearer JWT obrigatório", code: "UNAUTHORIZED" };
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !service) throw new Error("Configuração Supabase indisponível");
  const client = createClient(url, anon, { global: { headers: { Authorization: token } } });
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError || !auth.user) throw { status: 401, message: "Sessão inválida ou expirada", code: "INVALID_JWT" };
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: permission, error } = await admin.from("platform_admins").select("user_id, role, is_active")
    .eq("user_id", auth.user.id).eq("is_active", true).maybeSingle();
  if (error) throw error;
  if (!permission) throw { status: 403, message: "Administrador de plataforma inativo ou não autorizado", code: "FORBIDDEN" };
  return { admin, user: auth.user, role: permission.role };
}

function requireRole(role: string, allowed: string[]) {
  if (!allowed.includes(role)) {
    throw { status: 403, message: "Perfil sem permissão para esta operação", code: "FORBIDDEN" };
  }
}

function reason(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < 10) {
    throw { status: 400, message: "Motivo deve ter pelo menos 10 caracteres", code: "REASON_REQUIRED" };
  }
  return normalized;
}

async function stripeGet(path: string) {
  const secret = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secret) throw new Error("Configuração Stripe indisponível");
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!response.ok) throw { status: 502, message: "Não foi possível consultar a Stripe", code: "STRIPE_ERROR" };
  return await response.json();
}

async function searchTenants(admin: any, body: any) {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const filters = body.filters && typeof body.filters === "object" ? body.filters : {};
  const tenantStatus = filters.tenant_status || null;
  const planCode = filters.plan_code || null;
  const subscriptionStatus = filters.subscription_status || null;
  if (tenantStatus && !tenantStatuses.has(tenantStatus)) throw { status: 400, message: "Status de empresa inválido", code: "INVALID_FILTER" };
  if (planCode && !planCodes.has(planCode)) throw { status: 400, message: "Plano inválido", code: "INVALID_FILTER" };
  const requestedPage = Number.isSafeInteger(body.page) && body.page > 0 ? body.page : 1;
  const pageSize = Number.isSafeInteger(body.page_size) ? Math.min(100, Math.max(1, body.page_size)) : 20;
  const { data, error } = await admin.rpc("prospecta_admin_list_tenants", {
    p_search: query || null,
    p_plan_code: planCode,
    p_tenant_status: tenantStatus,
    p_subscription_status: subscriptionStatus,
    p_page: requestedPage,
    p_page_size: pageSize,
  });
  if (error) throw error;
  return data;
}

async function tenantDetail(admin: any, tenantId: string, role: string) {
  const { data, error } = await admin.rpc("prospecta_admin_get_tenant", { p_tenant_id: tenantId });
  if (error) throw error;
  if (!data?.tenant || !data?.subscription) {
    throw { status: 409, message: "Empresa sem assinatura configurada", code: "SUBSCRIPTION_MISSING" };
  }
  let stripe = null;
  let warning = null;
  const isViewer = role === "viewer";
  if (!isViewer && data.tenant.stripe_customer_id) {
    try {
      const customerId = encodeURIComponent(data.tenant.stripe_customer_id);
      const [customer, invoices] = await Promise.all([
        stripeGet(`/customers/${customerId}`),
        stripeGet(`/invoices?customer=${customerId}&limit=10`),
      ]);
      stripe = {
        customer_email: customer.deleted ? null : customer.email ?? null,
        latest_invoices: (invoices.data ?? []).map((invoice) => ({
          id: invoice.id, status: invoice.status, amount_due: invoice.amount_due,
          hosted_invoice_url: invoice.hosted_invoice_url ?? null,
        })),
      };
    } catch (error) {
      console.error("Enriquecimento Stripe indisponível", tenantId, error);
      warning = "Dados locais carregados, mas o enriquecimento Stripe está indisponível.";
    }
  }
  return {
    tenant: {
      id: data.tenant.id, name: data.tenant.name, slug: data.tenant.slug,
      status: data.tenant.status,
      stripe_customer_id: isViewer ? null : data.tenant.stripe_customer_id ?? null,
      created_at: data.tenant.created_at,
    },
    subscription: {
      plan_code: data.subscription.plan_code, status: data.subscription.status,
      stripe_subscription_id: isViewer ? null : data.subscription.stripe_subscription_id ?? null,
      current_period_start: data.subscription.current_period_start,
      current_period_end: data.subscription.current_period_end,
      cancel_at_period_end: Boolean(data.subscription.cancel_at_period_end),
    },
    usage: {
      leads_used: Number(data.usage?.leads_used ?? 0), leads_limit: Number(data.usage?.leads_limit ?? 0),
      period_start: data.usage?.period_start ?? data.subscription.current_period_start,
      period_end: data.usage?.period_end ?? data.subscription.current_period_end,
    },
    members: (data.members ?? []).map((member) => ({
      user_id: member.user_id,
      email: isViewer ? null : member.email,
      name: isViewer ? "Usuário protegido" : member.name,
      position: isViewer ? null : member.position ?? null,
      phone: isViewer ? null : member.phone ?? null,
      is_active: Boolean(member.is_active), tenant_role: member.tenant_role,
      last_sign_in_at: isViewer ? null : member.last_sign_in_at ?? null,
    })),
    grants: (data.grants ?? [])
      .filter((grant) => ["manual_payment", "billing_exempt"].includes(grant.grant_type))
      .map((grant) => ({
        id: grant.id, grant_type: grant.grant_type, plan_code: grant.plan_code,
        valid_from: grant.valid_from, valid_until: grant.valid_until,
        reason: isViewer ? "" : grant.reason, revoked_at: grant.revoked_at ?? null,
      })),
    recent_audit: (data.recent_audit ?? []).map((entry) => ({
      id: entry.id, actor_email: isViewer ? null : entry.actor_email ?? null,
      action: entry.action, reason: isViewer ? "" : entry.reason ?? "", created_at: entry.created_at,
      payload_before: isViewer ? null : entry.payload_before ?? null,
      payload_after: isViewer ? null : entry.payload_after ?? null,
    })),
    stripe,
    ...(warning ? { warning } : {}),
  };
}

Deno.serve(async (req) => {
  const suppliedId = req.headers.get("x-request-id")?.trim();
  const id = suppliedId || crypto.randomUUID();
  if (suppliedId && !isUuid(suppliedId)) {
    return respond(req, crypto.randomUUID(), 400, undefined, "x-request-id deve ser UUID", "INVALID_REQUEST_ID");
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  const origin = req.headers.get("origin");
  if (origin && !origins.includes(origin)) return respond(req, id, 403, undefined, "Origem não permitida", "ORIGIN_DENIED");
  if (req.method !== "POST") return respond(req, id, 405, undefined, "Método não permitido", "METHOD_NOT_ALLOWED");
  try {
    const { admin, user, role } = await authorize(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return respond(req, id, 400, undefined, "Corpo JSON inválido", "INVALID_INPUT");
    if (body.action === "search") {
      requireRole(role, ["viewer", "operator", "billing"]);
      const data = await searchTenants(admin, body);
      if (role === "viewer") {
        data.items = (data.items ?? []).map((item) => ({
          ...item,
          owner_email: null,
          stripe_customer_id: null,
          stripe_subscription_id: null,
        }));
      }
      return respond(req, id, 200, data);
    }
    if (body.action === "get") {
      requireRole(role, ["viewer", "operator", "billing"]);
      if (!isUuid(body.tenant_id)) return respond(req, id, 400, undefined, "tenant_id inválido", "INVALID_INPUT");
      return respond(req, id, 200, await tenantDetail(admin, body.tenant_id, role));
    }
    if (body.action !== "update") return respond(req, id, 400, undefined, "Ação inválida", "INVALID_ACTION");
    requireRole(role, ["operator", "billing"]);
    if (!isUuid(body.tenant_id) || !body.patch || typeof body.patch !== "object") {
      return respond(req, id, 400, undefined, "tenant_id e patch são obrigatórios", "INVALID_INPUT");
    }
    const mutationReason = reason(body.reason);
    const patch: Record<string, unknown> = {};
    if ("name" in body.patch) {
      if (typeof body.patch.name !== "string" || !body.patch.name.trim()) throw { status: 400, message: "Nome inválido", code: "INVALID_PATCH" };
      patch.name = body.patch.name.trim();
    }
    if ("slug" in body.patch) {
      if (typeof body.patch.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.patch.slug)) {
        throw { status: 400, message: "Slug inválido", code: "INVALID_PATCH" };
      }
      patch.slug = body.patch.slug;
    }
    if ("status" in body.patch) {
      if (!tenantStatuses.has(body.patch.status)) throw { status: 400, message: "Status inválido", code: "INVALID_PATCH" };
      patch.status = body.patch.status;
    }
    if (!Object.keys(patch).length) throw { status: 400, message: "Patch vazio", code: "INVALID_PATCH" };
    const { data, error } = await admin.rpc("prospecta_admin_update_tenant", {
      p_tenant_id: body.tenant_id,
      p_patch: patch,
      p_reason: mutationReason,
      p_actor_id: user.id,
      p_request_id: id,
    });
    if (error) throw error;
    return respond(req, id, 200, data);
  } catch (error) {
    console.error("admin-tenants", id, error);
    const mapped = mappedError(error, "Não foi possível processar empresas");
    return respond(req, id, mapped.status, undefined, mapped.message, mapped.code);
  }
});
