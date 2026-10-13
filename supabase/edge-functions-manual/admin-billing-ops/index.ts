// @ts-nocheck
// Função autocontida para colar em supabase/functions/admin-billing-ops/index.ts.
// Depende do stripe-webhook já existente no LeadFlow para sincronização das
// assinaturas Stripe; este handler não duplica o processamento do webhook.
import { createClient } from "npm:@supabase/supabase-js@2";

const origins = (Deno.env.get("ADMIN_ALLOWED_ORIGINS") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
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
  if (error?.code === "23505") return { status: 409, message: "Operação duplicada ou em conflito", code: "CONFLICT" };
  if (error?.code === "23503") return { status: 409, message: "Operação conflita com dados relacionados", code: "REFERENCE_CONFLICT" };
  if (error?.code === "22P02") return { status: 400, message: "Identificador ou valor inválido", code: "INVALID_INPUT" };
  if (error?.code === "PGRST116") return { status: 404, message: "Registro não encontrado", code: "NOT_FOUND" };
  if (error?.code === "P0001") {
    const text = String(error.message ?? "").toLowerCase();
    if (text.includes("permissão") || text.includes("acesso negado")) {
      return { status: 403, message: "Perfil sem permissão para esta operação", code: "FORBIDDEN" };
    }
    if (text.includes("não encontrad")) return { status: 404, message: "Registro não encontrado", code: "NOT_FOUND" };
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
  const userClient = createClient(url, anon, { global: { headers: { Authorization: token } } });
  const { data: auth, error: authError } = await userClient.auth.getUser();
  if (authError || !auth.user) throw { status: 401, message: "Sessão inválida ou expirada", code: "INVALID_JWT" };
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: permission, error } = await admin.from("platform_admins").select("user_id, role, is_active")
    .eq("user_id", auth.user.id).eq("is_active", true).maybeSingle();
  if (error) throw error;
  if (!permission) throw { status: 403, message: "Administrador de plataforma inativo ou não autorizado", code: "FORBIDDEN" };
  return { admin, user: auth.user, role: permission.role };
}

async function stripeGet(path: string) {
  const secret = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secret) throw new Error("Configuração Stripe indisponível");
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!response.ok) {
    console.error("Falha ao consultar assinatura Stripe", response.status);
    throw { status: 502, message: "Não foi possível validar a assinatura na Stripe", code: "STRIPE_ERROR" };
  }
  return await response.json();
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
    const reason = body?.reason?.trim();
    if (!["grant_manual_payment", "revoke_manual_payment", "adjust_quota"].includes(body?.action) ||
      !isUuid(body?.tenant_id)) {
      return respond(req, id, 400, undefined, "action e tenant_id válidos são obrigatórios", "INVALID_INPUT");
    }
    if (!reason || reason.length < 10) {
      return respond(req, id, 400, undefined, "Motivo deve ter pelo menos 10 caracteres", "REASON_REQUIRED");
    }
    let result;
    if (body.action === "grant_manual_payment") {
      if (role !== "billing") return respond(req, id, 403, undefined, "Perfil billing obrigatório", "FORBIDDEN");
      const validUntil = new Date(body.valid_until);
      if (!body.plan_code || !Number.isFinite(validUntil.getTime()) || validUntil <= new Date()) {
        return respond(req, id, 400, undefined, "plan_code e valid_until futuro são obrigatórios", "INVALID_GRANT");
      }
      const { data: plan, error: planError } = await admin.from("subscription_plans")
        .select("code").eq("code", body.plan_code).eq("active", true).maybeSingle();
      if (planError) throw planError;
      if (!plan) return respond(req, id, 400, undefined, "Plano inválido ou inativo", "INVALID_PLAN");
      const [{ data: local, error: subscriptionError }, { data: tenant, error: tenantError }] = await Promise.all([
        admin.from("tenant_subscriptions").select("stripe_subscription_id").eq("tenant_id", body.tenant_id).maybeSingle(),
        admin.from("tenants").select("stripe_customer_id").eq("id", body.tenant_id).maybeSingle(),
      ]);
      if (subscriptionError || tenantError) throw subscriptionError ?? tenantError;
      const stripeSubscriptions = [];
      const seenSubscriptionIds = new Set();
      if (local?.stripe_subscription_id) {
        stripeSubscriptions.push(
          await stripeGet(`/subscriptions/${encodeURIComponent(local.stripe_subscription_id)}`),
        );
        seenSubscriptionIds.add(local.stripe_subscription_id);
      }
      if (tenant?.stripe_customer_id) {
        let startingAfter = null;
        let hasMore = true;
        while (hasMore) {
          const query = new URLSearchParams({
            customer: tenant.stripe_customer_id, status: "all", limit: "100",
          });
          if (startingAfter) query.set("starting_after", startingAfter);
          const page = await stripeGet(`/subscriptions?${query.toString()}`);
          for (const subscription of page.data ?? []) {
            if (!seenSubscriptionIds.has(subscription.id)) {
              stripeSubscriptions.push(subscription);
              seenSubscriptionIds.add(subscription.id);
            }
          }
          hasMore = Boolean(page.has_more) && Boolean(page.data?.length);
          startingAfter = page.data?.at(-1)?.id ?? null;
        }
      }
      if (stripeSubscriptions.some((subscription) =>
        ["active", "trialing", "past_due", "unpaid"].includes(subscription.status)
      )) {
        return respond(req, id, 409, undefined, "Pagamento manual conflita com assinatura Stripe ativa", "ACTIVE_STRIPE_CONFLICT");
      }
      const { data, error } = await admin.rpc("prospecta_admin_create_billing_grant", {
        p_tenant_id: body.tenant_id, p_grant_type: "manual_payment", p_plan_code: body.plan_code,
        p_valid_until: validUntil.toISOString(), p_reason: reason, p_actor_id: user.id, p_request_id: id,
      });
      if (error) throw error;
      result = data;
    } else if (body.action === "revoke_manual_payment") {
      if (role !== "billing") return respond(req, id, 403, undefined, "Perfil billing obrigatório", "FORBIDDEN");
      if (!isUuid(body.grant_id)) {
        return respond(req, id, 400, undefined, "grant_id inválido", "INVALID_INPUT");
      }
      const { data: grant, error: grantError } = await admin.from("tenant_billing_grants")
        .select("id").eq("id", body.grant_id).eq("tenant_id", body.tenant_id)
        .eq("grant_type", "manual_payment").maybeSingle();
      if (grantError) throw grantError;
      if (!grant) return respond(req, id, 404, undefined, "Pagamento manual não encontrado", "NOT_FOUND");
      const { data, error } = await admin.rpc("prospecta_admin_revoke_billing_grant", {
        p_tenant_id: body.tenant_id,
        p_grant_id: body.grant_id,
        p_reason: reason,
        p_actor_id: user.id,
        p_request_id: id,
      });
      if (error) throw error;
      result = data;
    } else {
      if (!["operator", "billing"].includes(role)) {
        return respond(req, id, 403, undefined, "Perfil sem permissão para ajustar quota", "FORBIDDEN");
      }
      if (!Number.isSafeInteger(body.quantity) || body.quantity === 0) {
        return respond(req, id, 400, undefined, "quantity deve ser um inteiro diferente de zero", "INVALID_QUOTA");
      }
      if (typeof body.idempotency_key !== "string" || !body.idempotency_key.trim()) {
        return respond(req, id, 400, undefined, "idempotency_key é obrigatória", "INVALID_INPUT");
      }
      if (!isUuid(body.idempotency_key.trim())) {
        return respond(req, id, 400, undefined, "idempotency_key inválida", "INVALID_INPUT");
      }
      const { data, error } = await admin.rpc("prospecta_admin_adjust_quota", {
        p_tenant_id: body.tenant_id, p_delta: body.quantity, p_reason: reason,
        p_actor_id: user.id, p_request_id: body.idempotency_key.trim(),
      });
      if (error) throw error;
      result = {
        leads_used_before: Number(data.leads_used_before),
        leads_used_after: Number(data.leads_used_after),
        leads_limit: Number(data.leads_limit),
      };
    }
    return respond(req, id, 200, result);
  } catch (error) {
    console.error("admin-billing-ops", id, error);
    const mapped = mappedError(error, "Não foi possível processar a operação de cobrança");
    return respond(req, id, mapped.status, undefined, mapped.message, mapped.code);
  }
});
