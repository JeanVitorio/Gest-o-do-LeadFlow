// @ts-nocheck
// Função autocontida para colar em supabase/functions/admin-billing-stripe/index.ts.
// Depende do stripe-webhook já existente no LeadFlow para sincronizar
// tenant_subscriptions; este handler não duplica o processamento do webhook.
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
  if (error?.code === "23505") return { status: 409, message: "Registro já existe ou está em conflito", code: "CONFLICT" };
  if (error?.code === "23503") return { status: 409, message: "Operação conflita com dados relacionados", code: "REFERENCE_CONFLICT" };
  if (error?.code === "22P02") return { status: 400, message: "Identificador ou valor inválido", code: "INVALID_INPUT" };
  if (error?.code === "PGRST116") return { status: 404, message: "Registro não encontrado", code: "NOT_FOUND" };
  if (error?.code === "P0001") {
    const text = String(error.message ?? "").toLowerCase();
    if (text.includes("permissão") || text.includes("acesso negado")) {
      return { status: 403, message: "Perfil sem permissão para esta operação", code: "FORBIDDEN" };
    }
    if (text.includes("não encontrad")) return { status: 404, message: "Registro não encontrado", code: "NOT_FOUND" };
    if (text.includes("conflit") || text.includes("não pode") || text.includes("já ")) {
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

async function stripe(path: string, secret: string, init: RequestInit, requestId: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${secret}` };
  if (init.method !== "GET") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["Idempotency-Key"] = requestId;
  }
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const stripeError = payload?.error;
    console.error("Stripe recusou operação", requestId, response.status, stripeError?.code ?? stripeError?.type);
    throw {
      status: response.status >= 500 ? 502 : response.status,
      message: stripeError?.message ?? "Stripe recusou a operação",
      code: stripeError?.code ?? stripeError?.type ?? "STRIPE_ERROR",
      stripeFailure: true,
    };
  }
  return await response.json();
}

async function externalOperation(
  admin: any,
  actorId: string,
  operationId: string,
  tenantId: string,
  action: string,
  payload: Record<string, unknown>,
  reason: string,
  execute: (id: string) => Promise<Record<string, unknown>>,
) {
  const begun = await admin.rpc("prospecta_admin_begin_external_operation", {
    p_operation_id: operationId,
    p_actor_id: actorId,
    p_tenant_id: tenantId,
    p_action: action,
    p_payload: payload,
    p_reason: reason,
  });
  if (begun.error) throw begun.error;
  if (begun.data?.status === "succeeded") return begun.data.result;
  if (begun.data?.status === "failed") {
    throw { status: 409, message: "Operação anterior falhou; envie um novo request id", code: "FAILED_REPLAY" };
  }
  let result;
  try {
    result = await execute(begun.data.operation_id);
  } catch (error) {
    const failed = await admin.rpc("prospecta_admin_fail_external_operation", {
      p_operation_id: operationId,
      p_actor_id: actorId,
      p_error: error.code ?? "EXTERNAL_OPERATION_ERROR",
      p_result: { status: error.status ?? 500, code: error.code ?? "EXTERNAL_OPERATION_ERROR" },
      p_reason: reason,
      p_request_id: crypto.randomUUID(),
    });
    if (failed.error) console.error("Falha ao registrar operação externa malsucedida", operationId, failed.error);
    throw error;
  }
  const completed = await admin.rpc("prospecta_admin_complete_external_operation", {
    p_operation_id: operationId,
    p_actor_id: actorId,
    p_result: result,
    p_reason: reason,
    p_request_id: crypto.randomUUID(),
  });
  if (completed.error) {
    console.error("Falha ao concluir operação Stripe no outbox", operationId, completed.error);
    throw {
      status: 503,
      message: "Operação aplicada, mas a confirmação está pendente; repita com o mesmo request id",
      code: "OUTBOX_COMPLETION_PENDING",
    };
  }
  return result;
}

function validateSubscriptionOwnership(subscription: any, tenant: any) {
  const customerId = typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer?.id;
  if (!tenant.stripe_customer_id || customerId !== tenant.stripe_customer_id ||
    subscription.metadata?.tenant_id !== tenant.id) {
    throw { status: 409, message: "Assinatura Stripe não pertence à empresa", code: "STRIPE_OWNERSHIP_MISMATCH" };
  }
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
    if (role !== "billing") {
      return respond(req, id, 403, undefined, "Perfil billing obrigatório", "FORBIDDEN");
    }
    const secret = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secret) throw new Error("Configuração Stripe indisponível");
    const body = await req.json().catch(() => null);
    const reason = body?.reason?.trim();
    if (!["change_plan", "cancel_subscription"].includes(body?.action) || !isUuid(body?.tenant_id)) {
      return respond(req, id, 400, undefined, "action e tenant_id válidos são obrigatórios", "INVALID_INPUT");
    }
    if (!reason || reason.length < 10) {
      return respond(req, id, 400, undefined, "Motivo deve ter pelo menos 10 caracteres", "REASON_REQUIRED");
    }
    if (body.action === "change_plan") {
      if (!body.plan_code || body.plan_code === "free") {
        return respond(req, id, 400, undefined, "plan_code pago é obrigatório", "INVALID_PLAN");
      }
      if (!["create_prorations", "none"].includes(body.proration_behavior)) {
        return respond(req, id, 400, undefined, "proration_behavior inválido", "INVALID_INPUT");
      }
      const result = await externalOperation(
        admin,
        user.id,
        id,
        body.tenant_id,
        "billing.change_plan",
        { plan_code: body.plan_code, proration_behavior: body.proration_behavior },
        reason,
        async (operationId) => {
          const [
            { data: local, error: subscriptionError },
            { data: tenant, error: tenantError },
            { data: plan, error: planError },
            { data: activePlans, error: activePlansError },
          ] = await Promise.all([
            admin.from("tenant_subscriptions").select("tenant_id, plan_code, stripe_subscription_id")
              .eq("tenant_id", body.tenant_id).maybeSingle(),
            admin.from("tenants").select("id, name, stripe_customer_id").eq("id", body.tenant_id).single(),
            admin.from("subscription_plans").select("code, stripe_price_id")
              .eq("code", body.plan_code).eq("active", true).maybeSingle(),
            admin.from("subscription_plans").select("stripe_price_id")
              .eq("active", true).not("stripe_price_id", "is", null),
          ]);
          if (subscriptionError || tenantError || planError || activePlansError) {
            throw subscriptionError ?? tenantError ?? planError ?? activePlansError;
          }
          if (!plan?.stripe_price_id) {
            throw { status: 409, message: "Plano sem preço Stripe configurado", code: "PRICE_NOT_CONFIGURED" };
          }
          const appUrl = (Deno.env.get("LEADFLOW_APP_URL") ?? "").trim().replace(/\/+$/, "");
          if (!appUrl.startsWith("https://")) throw new Error("LEADFLOW_APP_URL deve ser HTTPS");
          const allowedPriceIds = new Set((activePlans ?? []).map((item) => item.stripe_price_id));
          let current = null;
          if (local?.plan_code !== "free" && local?.stripe_subscription_id) {
            current = await stripe(`/subscriptions/${encodeURIComponent(local.stripe_subscription_id)}`,
              secret, { method: "GET" }, operationId);
            validateSubscriptionOwnership(current, tenant);
          }
          if (current && ["active", "trialing", "past_due", "unpaid"].includes(current.status)) {
            const matchingItems = (current.items?.data ?? []).filter((item) =>
              allowedPriceIds.has(typeof item.price === "string" ? item.price : item.price?.id)
            );
            if (matchingItems.length !== 1) {
              throw { status: 409, message: "Item de assinatura permitido não pôde ser identificado", code: "STRIPE_ITEM_MISMATCH" };
            }
            const form = new URLSearchParams();
            form.set("items[0][id]", matchingItems[0].id);
            form.set("items[0][price]", plan.stripe_price_id);
            form.set("proration_behavior", body.proration_behavior);
            await stripe(`/subscriptions/${encodeURIComponent(current.id)}`,
              secret, { method: "POST", body: form }, operationId);
            return { mode: "updated" };
          }
          if (!tenant.stripe_customer_id) {
            const customerForm = new URLSearchParams();
            customerForm.set("name", tenant.name);
            customerForm.set("metadata[tenant_id]", tenant.id);
            const customer = await stripe("/customers", secret,
              { method: "POST", body: customerForm }, `${operationId}-customer`);
            const customerUpdate = await admin.from("tenants")
              .update({ stripe_customer_id: customer.id })
              .eq("id", tenant.id);
            if (customerUpdate.error) throw customerUpdate.error;
            tenant.stripe_customer_id = customer.id;
          } else {
            const customer = await stripe(
              `/customers/${encodeURIComponent(tenant.stripe_customer_id)}`,
              secret,
              { method: "GET" },
              `${operationId}-customer-read`,
            );
            if (customer.deleted || customer.metadata?.tenant_id !== tenant.id) {
              throw {
                status: 409,
                message: "Customer Stripe não pertence à empresa",
                code: "STRIPE_CUSTOMER_OWNERSHIP_MISMATCH",
              };
            }
          }
          const checkoutForm = new URLSearchParams();
          checkoutForm.set("mode", "subscription");
          checkoutForm.set("customer", tenant.stripe_customer_id);
          checkoutForm.set("line_items[0][price]", plan.stripe_price_id);
          checkoutForm.set("line_items[0][quantity]", "1");
          checkoutForm.set("allow_promotion_codes", "true");
          checkoutForm.set("client_reference_id", tenant.id);
          checkoutForm.set("metadata[tenant_id]", tenant.id);
          checkoutForm.set("metadata[plan_code]", body.plan_code);
          checkoutForm.set("subscription_data[metadata][tenant_id]", tenant.id);
          checkoutForm.set("subscription_data[metadata][plan_code]", body.plan_code);
          checkoutForm.set("success_url", `${appUrl}/LeadFlow/billing?checkout=success`);
          checkoutForm.set("cancel_url", `${appUrl}/LeadFlow/billing?checkout=cancelled`);
          const session = await stripe("/checkout/sessions", secret,
            { method: "POST", body: checkoutForm }, operationId);
          return { mode: "checkout_required", checkout_url: session.url };
        },
      );
      return respond(req, id, 200, result);
    }
    if (!["at_period_end", "immediate"].includes(body.mode)) {
      return respond(req, id, 400, undefined, "Modo de cancelamento inválido", "INVALID_INPUT");
    }
    const result = await externalOperation(
      admin,
      user.id,
      id,
      body.tenant_id,
      "billing.cancel_subscription",
      { mode: body.mode },
      reason,
      async (operationId) => {
        const [{ data: local, error: subscriptionError }, { data: tenant, error: tenantError }] = await Promise.all([
          admin.from("tenant_subscriptions").select("plan_code, stripe_subscription_id")
            .eq("tenant_id", body.tenant_id).maybeSingle(),
          admin.from("tenants").select("id, stripe_customer_id").eq("id", body.tenant_id).single(),
        ]);
        if (subscriptionError || tenantError) throw subscriptionError ?? tenantError;
        if (!local?.stripe_subscription_id) {
          throw { status: 409, message: "Empresa não possui assinatura Stripe", code: "STRIPE_SUBSCRIPTION_REQUIRED" };
        }
        const current = await stripe(`/subscriptions/${encodeURIComponent(local.stripe_subscription_id)}`,
          secret, { method: "GET" }, operationId);
        validateSubscriptionOwnership(current, tenant);
        const updated = body.mode === "immediate"
          ? await stripe(`/subscriptions/${encodeURIComponent(current.id)}`,
            secret, { method: "DELETE" }, operationId)
          : await stripe(`/subscriptions/${encodeURIComponent(current.id)}`, secret, {
            method: "POST", body: new URLSearchParams({ cancel_at_period_end: "true" }),
          }, operationId);
        return { stripe_subscription_id: updated.id };
      },
    );
    return respond(req, id, 200, result);
  } catch (error) {
    console.error("admin-billing-stripe", id, error);
    const mapped = mappedError(error, "Não foi possível atualizar a assinatura");
    return respond(req, id, mapped.status, undefined, mapped.message, mapped.code);
  }
});
