// @ts-nocheck
// Função autocontida para colar em supabase/functions/admin-users/index.ts.
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
  if (error?.code === "PGRST116") return { status: 404, message: "Usuário não encontrado", code: "NOT_FOUND" };
  if (error?.code === "P0001") {
    const text = String(error.message ?? "").toLowerCase();
    if (text.includes("permissão") || text.includes("acesso negado")) {
      return { status: 403, message: "Perfil sem permissão para esta operação", code: "FORBIDDEN" };
    }
    if (text.includes("não encontrad") || text.includes("não pertence")) {
      return { status: 404, message: "Usuário ou vínculo não encontrado", code: "NOT_FOUND" };
    }
    if (text.includes("limite") || text.includes("não pode") || text.includes("já ")) {
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

function requireRole(role: string, allowed: string[]) {
  if (!allowed.includes(role)) throw { status: 403, message: "Perfil sem permissão para esta operação", code: "FORBIDDEN" };
}

function requiredReason(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < 10) throw { status: 400, message: "Motivo deve ter pelo menos 10 caracteres", code: "REASON_REQUIRED" };
  return normalized;
}

async function resolveTenantId(admin: any, userId: string, requestedTenantId?: string) {
  const [{ data: profile, error: profileError }, { data: memberships, error: membershipsError }] = await Promise.all([
    admin.from("profiles").select("active_tenant_id").eq("id", userId).single(),
    admin.from("tenant_memberships").select("tenant_id").eq("user_id", userId)
      .not("accepted_at", "is", null).order("created_at", { ascending: true }),
  ]);
  if (profileError || membershipsError) throw profileError ?? membershipsError;
  if (requestedTenantId) {
    if (!memberships?.some((membership) => membership.tenant_id === requestedTenantId)) {
      throw { status: 404, message: "Usuário não pertence à empresa informada", code: "MEMBERSHIP_NOT_FOUND" };
    }
    return requestedTenantId;
  }
  if (profile.active_tenant_id && memberships?.some((membership) => membership.tenant_id === profile.active_tenant_id)) {
    return profile.active_tenant_id;
  }
  if (memberships?.length === 1) return memberships[0].tenant_id;
  throw { status: 409, message: "tenant_id obrigatório para usuário com múltiplas empresas", code: "AMBIGUOUS_TENANT" };
}

async function scopedUuid(baseId: string, scope: string) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${baseId}:${scope}`),
  ));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function authUserIsBanned(authUser: any) {
  return Boolean(authUser?.banned_until && new Date(authUser.banned_until) > new Date());
}

async function failAuthOperation(
  admin: any,
  operationId: string,
  actorId: string,
  reason: string,
  error: any,
) {
  const failed = await admin.rpc("prospecta_admin_fail_external_operation", {
    p_operation_id: operationId,
    p_actor_id: actorId,
    p_error: error.code ?? "AUTH_OPERATION_ERROR",
    p_result: { status: error.status ?? 500, code: error.code ?? "AUTH_OPERATION_ERROR" },
    p_reason: reason,
    p_request_id: crypto.randomUUID(),
  });
  if (failed.error) {
    console.error("Falha ao registrar operação Auth malsucedida", operationId, failed.error);
    return false;
  }
  return true;
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
      requireRole(role, ["operator", "billing"]);
      if (body.tenant_id !== undefined && !isUuid(body.tenant_id)) {
        return respond(req, id, 400, undefined, "tenant_id inválido", "INVALID_INPUT");
      }
      const { data, error } = await admin.rpc("prospecta_admin_list_users", {
        p_search: typeof body.query === "string" ? body.query.trim() || null : null,
        p_tenant_id: body.tenant_id || null, p_is_active: null,
        p_page: Number.isSafeInteger(body.page) && body.page > 0 ? body.page : 1,
        p_page_size: Number.isSafeInteger(body.page_size) ? Math.min(100, Math.max(1, body.page_size)) : 20,
      });
      if (error) throw error;
      return respond(req, id, 200, data);
    }
    if (!["update", "block", "unblock"].includes(body.action) || !isUuid(body.user_id)) {
      return respond(req, id, 400, undefined, "Ação ou user_id inválido", "INVALID_INPUT");
    }
    if (body.tenant_id !== undefined && !isUuid(body.tenant_id)) {
      return respond(req, id, 400, undefined, "tenant_id inválido", "INVALID_INPUT");
    }
    requireRole(role, ["operator", "billing"]);
    const mutationReason = requiredReason(body.reason);
    const targetTenantId = await resolveTenantId(admin, body.user_id, body.tenant_id);
    if (body.action === "block" || body.action === "unblock") {
      const isActive = body.action === "unblock";
      if (body.user_id === user.id && !isActive) {
        return respond(req, id, 409, undefined, "Não é permitido bloquear o próprio usuário", "SELF_DEACTIVATION");
      }
      if (!isActive) {
        const { data: targetAdmin, error: targetAdminError } = await admin.from("platform_admins")
          .select("user_id").eq("user_id", body.user_id).maybeSingle();
        if (targetAdminError) throw targetAdminError;
        if (targetAdmin) {
          return respond(req, id, 409, undefined, "Platform admins não podem ser bloqueados", "PLATFORM_ADMIN_PROTECTED");
        }
      }
      const operationAction = isActive ? "auth.unblock" : "auth.block";
      const operationPayload = {
        user_id: body.user_id,
        tenant_id: targetTenantId,
        is_active: isActive,
      };
      const begun = await admin.rpc("prospecta_admin_begin_external_operation", {
        p_operation_id: id,
        p_actor_id: user.id,
        p_tenant_id: targetTenantId,
        p_action: operationAction,
        p_payload: operationPayload,
        p_reason: mutationReason,
      });
      if (begun.error) throw begun.error;
      if (begun.data?.status === "succeeded") return respond(req, id, 200, begun.data.result);
      if (begun.data?.status === "failed") {
        return respond(req, id, 409, undefined,
          "Operação anterior falhou; envie um novo request id", "FAILED_REPLAY");
      }
      let authData;
      try {
        const currentAuth = await admin.auth.admin.getUserById(body.user_id);
        if (currentAuth.error || !currentAuth.data.user) {
          throw currentAuth.error ?? new Error("Usuário Auth não encontrado");
        }
        authData = currentAuth.data;
      } catch (error) {
        const markedFailed = await failAuthOperation(admin, id, user.id, mutationReason, error);
        if (!markedFailed) {
          return respond(req, id, 503, undefined,
            "Estado do Auth requer reconciliação; repita com o mesmo request id",
            "OUTBOX_RECONCILIATION_REQUIRED");
        }
        throw error;
      }
      const previousWasBanned = authUserIsBanned(authData.user);
      const desiredBanned = !isActive;
      const oldBannedUntil = authData.user.banned_until ? new Date(authData.user.banned_until) : null;
      const remainingSeconds = oldBannedUntil && oldBannedUntil > new Date()
        ? Math.max(1, Math.ceil((oldBannedUntil.getTime() - Date.now()) / 1000))
        : 0;
      const previousBanDuration = remainingSeconds > 0 ? `${remainingSeconds}s` : "none";

      let authUpdateError = null;
      try {
        const authUpdate = await admin.auth.admin.updateUserById(body.user_id, {
          ban_duration: isActive ? "none" : "876000h",
        });
        authUpdateError = authUpdate.error;
      } catch (error) {
        authUpdateError = error;
      }
      if (authUpdateError) {
        const verification = await admin.auth.admin.getUserById(body.user_id);
        if (verification.error || !verification.data.user) {
          return respond(req, id, 503, undefined,
            "Estado do Auth requer reconciliação; repita com o mesmo request id",
            "OUTBOX_RECONCILIATION_REQUIRED");
        }
        const currentIsBanned = authUserIsBanned(verification.data.user);
        if (currentIsBanned !== desiredBanned) {
          if (currentIsBanned !== previousWasBanned) {
            return respond(req, id, 503, undefined,
              "Estado do Auth requer reconciliação; repita com o mesmo request id",
              "OUTBOX_RECONCILIATION_REQUIRED");
          }
          const markedFailed = await failAuthOperation(
            admin, id, user.id, mutationReason, authUpdateError,
          );
          if (!markedFailed) {
            return respond(req, id, 503, undefined,
              "Estado do Auth requer reconciliação; repita com o mesmo request id",
              "OUTBOX_RECONCILIATION_REQUIRED");
          }
          throw authUpdateError;
        }
      }

      let localError = null;
      try {
        const { error } = await admin.rpc("prospecta_admin_set_user_active", {
          p_tenant_id: targetTenantId,
          p_user_id: body.user_id,
          p_is_active: isActive,
          p_reason: mutationReason,
          p_actor_id: user.id,
          p_request_id: await scopedUuid(id, "auth-profile"),
        });
        localError = error;
      } catch (error) {
        localError = error;
      }
      if (localError) {
        const compensation = await admin.auth.admin.updateUserById(body.user_id, {
          ban_duration: previousBanDuration,
        });
        if (compensation.error) {
          console.error("Falha ao compensar banimento Auth", id, compensation.error);
          return respond(req, id, 503, undefined,
            "Estado do Auth requer reconciliação; repita com o mesmo request id",
            "OUTBOX_RECONCILIATION_REQUIRED");
        }
        const verification = await admin.auth.admin.getUserById(body.user_id);
        if (verification.error || !verification.data.user ||
          authUserIsBanned(verification.data.user) !== previousWasBanned) {
          return respond(req, id, 503, undefined,
            "Estado do Auth requer reconciliação; repita com o mesmo request id",
            "OUTBOX_RECONCILIATION_REQUIRED");
        }
        const markedFailed = await failAuthOperation(admin, id, user.id, mutationReason, localError);
        if (!markedFailed) {
          return respond(req, id, 503, undefined,
            "Estado do Auth requer reconciliação; repita com o mesmo request id",
            "OUTBOX_RECONCILIATION_REQUIRED");
        }
        throw localError;
      }
      const result = { user_id: body.user_id };
      const completed = await admin.rpc("prospecta_admin_complete_external_operation", {
        p_operation_id: id,
        p_actor_id: user.id,
        p_result: result,
        p_reason: mutationReason,
        p_request_id: crypto.randomUUID(),
      });
      if (completed.error) {
        console.error("Falha ao concluir operação Auth no outbox", id, completed.error);
        return respond(req, id, 503, undefined,
          "Operação aplicada, mas a confirmação está pendente; repita com o mesmo request id",
          "OUTBOX_COMPLETION_PENDING");
      }
      return respond(req, id, 200, result);
    }
    if (!body.patch || typeof body.patch !== "object") {
      return respond(req, id, 400, undefined, "patch é obrigatório", "INVALID_INPUT");
    }
    const profilePatch: Record<string, unknown> = {};
    if ("name" in body.patch) {
      if (typeof body.patch.name !== "string" || !body.patch.name.trim()) throw { status: 400, message: "Nome inválido", code: "INVALID_PATCH" };
      profilePatch.name = body.patch.name.trim();
    }
    for (const field of ["position", "phone"]) {
      if (field in body.patch) {
        if (typeof body.patch[field] !== "string") throw { status: 400, message: `${field} inválido`, code: "INVALID_PATCH" };
        profilePatch[field] = body.patch[field].trim() || null;
      }
    }
    const requestedRole = body.patch.tenant_role;
    if (requestedRole !== undefined && !["admin", "member"].includes(requestedRole)) {
      throw { status: 400, message: "Papel na empresa inválido", code: "INVALID_PATCH" };
    }
    if (!Object.keys(profilePatch).length && requestedRole === undefined) {
      throw { status: 400, message: "Patch vazio", code: "INVALID_PATCH" };
    }
    const rpcPatch = { ...profilePatch };
    if (requestedRole !== undefined) rpcPatch.tenant_role = requestedRole;
    const { data, error } = await admin.rpc("prospecta_admin_update_user", {
      p_tenant_id: targetTenantId,
      p_user_id: body.user_id,
      p_patch: rpcPatch,
      p_reason: mutationReason,
      p_actor_id: user.id,
      p_request_id: id,
    });
    if (error) throw error;
    return respond(req, id, 200, data);
  } catch (error) {
    console.error("admin-users", id, error);
    const mapped = mappedError(error, "Não foi possível processar usuários");
    return respond(req, id, mapped.status, undefined, mapped.message, mapped.code);
  }
});
