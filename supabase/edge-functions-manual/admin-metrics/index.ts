// @ts-nocheck
// Função autocontida para colar em supabase/functions/admin-metrics/index.ts.
import { createClient } from "npm:@supabase/supabase-js@2";

const origins = (Deno.env.get("ADMIN_ALLOWED_ORIGINS") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const isUuid = (value: unknown) => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function headers(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": origins.includes(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-request-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
}

function reply(req: Request, requestId: string, status: number, data?: unknown, error?: string, code?: string) {
  return new Response(JSON.stringify(error
    ? { ok: false, request_id: requestId, error, code }
    : { ok: true, request_id: requestId, data }), { status, headers: headers(req) });
}

function mappedError(error: any, fallback: string) {
  if (error?.status) return { status: error.status, message: error.message, code: error.code ?? "REQUEST_ERROR" };
  if (error?.code === "23505" || error?.code === "23503") {
    return { status: 409, message: "Operação conflita com o estado atual", code: "CONFLICT" };
  }
  if (error?.code === "22P02") return { status: 400, message: "Identificador ou valor inválido", code: "INVALID_INPUT" };
  if (error?.code === "PGRST116") return { status: 404, message: "Registro não encontrado", code: "NOT_FOUND" };
  if (error?.code === "P0001") {
    const text = String(error.message ?? "").toLowerCase();
    if (text.includes("permissão") || text.includes("acesso negado")) {
      return { status: 403, message: "Perfil sem permissão para esta operação", code: "FORBIDDEN" };
    }
    return { status: 400, message: "Operação recusada", code: "BUSINESS_RULE" };
  }
  return { status: 500, message: fallback, code: "INTERNAL_ERROR" };
}

async function authorize(req: Request) {
  const authorization = req.headers.get("authorization");
  if (!authorization?.match(/^Bearer\s+\S+$/i)) throw { status: 401, message: "Bearer JWT obrigatório", code: "UNAUTHORIZED" };
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !serviceRole) throw new Error("Configuração Supabase indisponível");
  const userClient = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
  const { data: auth, error: authError } = await userClient.auth.getUser();
  if (authError || !auth.user) throw { status: 401, message: "Sessão inválida ou expirada", code: "INVALID_JWT" };
  const admin = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: platformAdmin, error } = await admin.from("platform_admins")
    .select("user_id, role, is_active").eq("user_id", auth.user.id).eq("is_active", true).maybeSingle();
  if (error) throw error;
  if (!platformAdmin) throw { status: 403, message: "Administrador de plataforma inativo ou não autorizado", code: "FORBIDDEN" };
  return { admin, actor: auth.user, platformAdmin };
}

Deno.serve(async (req) => {
  const suppliedId = req.headers.get("x-request-id")?.trim();
  const requestId = suppliedId || crypto.randomUUID();
  if (suppliedId && !isUuid(suppliedId)) {
    return reply(req, crypto.randomUUID(), 400, undefined, "x-request-id deve ser UUID", "INVALID_REQUEST_ID");
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(req) });
  const origin = req.headers.get("origin");
  if (origin && !origins.includes(origin)) return reply(req, requestId, 403, undefined, "Origem não permitida", "ORIGIN_DENIED");
  if (req.method !== "POST") return reply(req, requestId, 405, undefined, "Método não permitido", "METHOD_NOT_ALLOWED");
  try {
    const { admin, actor } = await authorize(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply(req, requestId, 400, undefined, "Corpo JSON inválido", "INVALID_INPUT");
    }
    if (body.action === "identity") {
      const { data, error } = await admin.rpc("prospecta_admin_get_identity", {
        p_actor_id: actor.id,
      });
      if (error) throw error;
      return reply(req, requestId, 200, data);
    }
    if (body.action !== undefined) {
      return reply(req, requestId, 400, undefined, "Ação inválida", "INVALID_ACTION");
    }
    const { data, error } = await admin.rpc("prospecta_admin_get_metrics");
    if (error) throw error;
    return reply(req, requestId, 200, data);
  } catch (error) {
    console.error("admin-metrics", requestId, error);
    const mapped = mappedError(error, "Não foi possível carregar as métricas");
    return reply(req, requestId, mapped.status, undefined, mapped.message, mapped.code);
  }
});
