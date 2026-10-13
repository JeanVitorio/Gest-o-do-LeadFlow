-- LeadFlow - camada SQL do painel global.
-- Execute este arquivo inteiro no SQL Editor do Supabase do LeadFlow.
-- Autocontido e idempotente para bancos que já receberam a implantação SaaS.

begin;

create extension if not exists pgcrypto;

alter table public.profiles
  add column if not exists position text,
  add column if not exists phone text;

alter table public.tenant_subscriptions
  add column if not exists stripe_last_event_created_at timestamptz,
  add column if not exists stripe_last_event_type text;

alter table public.subscription_plans
  add column if not exists stripe_product_id text;

-- ============================================================
-- TABELAS ADMINISTRATIVAS
-- ============================================================

create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null
    check (role in ('viewer', 'operator', 'billing')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.platform_audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid not null,
  actor_role text not null
    check (actor_role in ('viewer', 'operator', 'billing')),
  action text not null,
  target_type text not null,
  target_id text,
  tenant_id uuid references public.tenants(id) on delete restrict,
  request_id text,
  reason text,
  payload_before jsonb,
  payload_after jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint platform_audit_action_not_blank
    check (btrim(action) <> ''),
  constraint platform_audit_target_not_blank
    check (btrim(target_type) <> ''),
  constraint platform_audit_reason_valid
    check (reason is null or length(btrim(reason)) >= 10),
  constraint platform_audit_metadata_object
    check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.tenant_billing_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references public.tenants(id) on delete restrict,
  grant_type text not null
    check (
      grant_type in (
        'manual_payment',
        'billing_exempt',
        'billing_access',
        'quota_bonus'
      )
    ),
  plan_code text references public.subscription_plans(code),
  status_override text
    check (status_override in ('active', 'trialing')),
  leads_bonus integer,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null,
  reason text not null,
  idempotency_key text not null unique,
  created_by uuid not null,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  created_at timestamptz not null default now(),
  constraint tenant_billing_grants_period_valid
    check (valid_until > valid_from),
  constraint tenant_billing_grants_reason_not_blank
    check (length(btrim(reason)) >= 10),
  constraint tenant_billing_grants_payload_valid check (
    (
      grant_type = 'billing_access'
      and status_override is not null
      and leads_bonus is null
      and plan_code is null
    )
    or (
      grant_type = 'quota_bonus'
      and status_override is null
      and leads_bonus > 0
      and plan_code is null
    )
    or (
      grant_type in ('manual_payment', 'billing_exempt')
      and plan_code is not null
      and status_override is null
      and leads_bonus is null
    )
  ),
  constraint tenant_billing_grants_revocation_valid check (
    (revoked_at is null and revoked_by is null and revoke_reason is null)
    or (
      revoked_at is not null
      and revoked_by is not null
      and btrim(coalesce(revoke_reason, '')) <> ''
    )
  )
);

create table if not exists public.platform_external_operations (
  operation_id uuid primary key,
  actor_user_id uuid not null,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  action text not null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed')),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint platform_external_action_not_blank
    check (btrim(action) <> ''),
  constraint platform_external_payload_object
    check (jsonb_typeof(payload) = 'object'),
  constraint platform_external_state_valid check (
    (status = 'pending' and completed_at is null)
    or (status = 'succeeded' and completed_at is not null and error is null)
    or (
      status = 'failed'
      and completed_at is not null
      and btrim(coalesce(error, '')) <> ''
    )
  )
);

create table if not exists public.stripe_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  payload_hash text not null,
  event_created_at timestamptz not null,
  processed_at timestamptz not null default now(),
  constraint stripe_webhook_event_id_not_blank
    check (btrim(stripe_event_id) <> ''),
  constraint stripe_webhook_event_type_not_blank
    check (btrim(event_type) <> ''),
  constraint stripe_webhook_payload_hash_not_blank
    check (btrim(payload_hash) <> '')
);

-- Reaplicável sobre uma versão anterior da camada administrativa.
alter table public.platform_audit_log
  drop constraint if exists platform_audit_reason_valid;
alter table public.platform_audit_log
  add constraint platform_audit_reason_valid
  check (reason is null or length(btrim(reason)) >= 10) not valid;
alter table public.tenant_billing_grants
  drop constraint if exists tenant_billing_grants_reason_not_blank;
alter table public.tenant_billing_grants
  add constraint tenant_billing_grants_reason_not_blank
  check (length(btrim(reason)) >= 10) not valid;

create index if not exists platform_admins_active_role_idx
  on public.platform_admins (is_active, role);
create index if not exists platform_audit_created_idx
  on public.platform_audit_log (created_at desc, id desc);
create index if not exists platform_audit_tenant_idx
  on public.platform_audit_log (tenant_id, created_at desc);
create index if not exists platform_audit_actor_idx
  on public.platform_audit_log (actor_user_id, created_at desc);
create unique index if not exists platform_audit_request_uidx
  on public.platform_audit_log (request_id)
  where request_id is not null;
create index if not exists tenant_billing_grants_active_idx
  on public.tenant_billing_grants (tenant_id, valid_until)
  where revoked_at is null;
create index if not exists platform_tenants_status_created_idx
  on public.tenants (status, created_at desc, id);
create index if not exists platform_tenants_name_prefix_idx
  on public.tenants (lower(name) text_pattern_ops);
create index if not exists platform_tenants_slug_prefix_idx
  on public.tenants (lower(slug) text_pattern_ops);
create index if not exists platform_tenants_stripe_customer_idx
  on public.tenants (stripe_customer_id)
  where stripe_customer_id is not null;
create index if not exists platform_subscriptions_filter_idx
  on public.tenant_subscriptions (
    plan_code,
    status,
    tenant_id
  );
create index if not exists platform_subscriptions_stripe_idx
  on public.tenant_subscriptions (stripe_subscription_id)
  where stripe_subscription_id is not null;
create index if not exists platform_memberships_owner_lookup_idx
  on public.tenant_memberships (tenant_id, created_at, user_id)
  where accepted_at is not null and role = 'owner';
create index if not exists platform_external_operations_tenant_idx
  on public.platform_external_operations (
    tenant_id,
    created_at desc,
    operation_id
  );
create index if not exists platform_external_operations_status_idx
  on public.platform_external_operations (status, created_at);
create index if not exists stripe_webhook_events_created_idx
  on public.stripe_webhook_events (event_created_at desc);

-- Sem políticas globais: o frontend authenticated não consulta estas tabelas.
alter table public.platform_admins enable row level security;
alter table public.platform_audit_log enable row level security;
alter table public.tenant_billing_grants enable row level security;
alter table public.platform_external_operations enable row level security;
alter table public.stripe_webhook_events enable row level security;

revoke all on table public.platform_admins
  from public, anon, authenticated;
revoke all on table public.platform_audit_log
  from public, anon, authenticated;
revoke all on table public.tenant_billing_grants
  from public, anon, authenticated;
revoke all on table public.platform_external_operations
  from public, anon, authenticated;
revoke all on table public.stripe_webhook_events
  from public, anon, authenticated;
revoke all on sequence public.platform_audit_log_id_seq
  from public, anon, authenticated;

-- ============================================================
-- TRIGGERS DE INTEGRIDADE
-- ============================================================

create or replace function public.platform_touch_admin()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists platform_admins_touch
  on public.platform_admins;
create trigger platform_admins_touch
before update on public.platform_admins
for each row execute function public.platform_touch_admin();

drop trigger if exists platform_external_operations_touch
  on public.platform_external_operations;
create trigger platform_external_operations_touch
before update on public.platform_external_operations
for each row execute function public.platform_touch_admin();

create or replace function public.platform_reject_audit_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'O log de auditoria é imutável';
end;
$$;

drop trigger if exists platform_audit_log_immutable
  on public.platform_audit_log;
create trigger platform_audit_log_immutable
before update or delete on public.platform_audit_log
for each row execute function public.platform_reject_audit_mutation();

-- ============================================================
-- AUTORIZAÇÃO INTERNA
-- ============================================================

create or replace function public.platform_require_admin(
  p_actor_user_id uuid,
  p_allowed_roles text[]
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  role_value text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Esta função é exclusiva da service role';
  end if;
  if p_actor_user_id is null then
    raise exception 'Administrador responsável é obrigatório';
  end if;

  select admin.role into role_value
  from public.platform_admins admin
  where admin.user_id = p_actor_user_id
    and admin.is_active;

  if role_value is null
     or not (role_value = any(p_allowed_roles)) then
    raise exception 'Administrador sem permissão para esta operação';
  end if;

  return role_value;
end;
$$;

create or replace function public.platform_audit_once(
  p_request_id text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_tenant_id uuid,
  p_reason text,
  p_payload_before jsonb default null,
  p_payload_after jsonb default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table (audit_id bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  request_uuid uuid;
  existing_row public.platform_audit_log;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Esta função é exclusiva da service role';
  end if;
  begin
    request_uuid := btrim(p_request_id)::uuid;
  exception when invalid_text_representation then
    raise exception 'request_id deve ser UUID';
  end;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'Motivo deve ter ao menos 10 caracteres';
  end if;
  if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'Metadata da auditoria deve ser objeto';
  end if;

  select * into existing_row
  from public.platform_audit_log audit
  where audit.request_id = request_uuid::text;

  if not found then
    begin
      insert into public.platform_audit_log (
        actor_user_id, actor_role, action, target_type, target_id,
        tenant_id, request_id, reason, payload_before, payload_after,
        metadata
      )
      values (
        p_actor_user_id, p_actor_role, btrim(p_action),
        btrim(p_target_type), p_target_id, p_tenant_id,
        request_uuid::text, btrim(p_reason), p_payload_before,
        p_payload_after, coalesce(p_metadata, '{}'::jsonb)
      )
      returning id into audit_id;
      replayed := false;
      return next;
      return;
    exception when unique_violation then
      select * into existing_row
      from public.platform_audit_log audit
      where audit.request_id = request_uuid::text;
    end;
  end if;

  if existing_row.actor_user_id is distinct from p_actor_user_id
     or existing_row.actor_role is distinct from p_actor_role
     or existing_row.action is distinct from btrim(p_action)
     or existing_row.target_type is distinct from btrim(p_target_type)
     or existing_row.target_id is distinct from p_target_id
     or existing_row.tenant_id is distinct from p_tenant_id
     or existing_row.reason is distinct from btrim(p_reason)
     or existing_row.payload_before is distinct from p_payload_before
     or existing_row.payload_after is distinct from p_payload_after
     or existing_row.metadata is distinct from
       coalesce(p_metadata, '{}'::jsonb) then
    raise exception 'request_id já usado com parâmetros divergentes';
  end if;

  audit_id := existing_row.id;
  replayed := true;
  return next;
end;
$$;

-- Helper administrativo. Os grants não são somados automaticamente às
-- funções SaaS legadas: isso mudaria o contrato atual entre Stripe,
-- tenant_subscriptions e tenant_usage_periods. O painel pode consultar este
-- helper. billing_access/quota_bonus não liberam bots nem alteram quotas por
-- efeito colateral; mudanças efetivas de quota usam a RPC auditada específica.
create or replace function public.platform_effective_billing_grants(
  p_tenant_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'plan_code_override',
    (
      select grant_row.plan_code
      from public.tenant_billing_grants grant_row
      where grant_row.tenant_id = p_tenant_id
        and grant_row.grant_type in ('manual_payment', 'billing_exempt')
        and grant_row.revoked_at is null
        and clock_timestamp() >= grant_row.valid_from
        and clock_timestamp() < grant_row.valid_until
      order by
        grant_row.valid_from desc,
        grant_row.created_at desc,
        grant_row.id desc
      limit 1
    ),
    'billing_exempt',
    exists (
      select 1
      from public.tenant_billing_grants grant_row
      where grant_row.tenant_id = p_tenant_id
        and grant_row.grant_type = 'billing_exempt'
        and grant_row.revoked_at is null
        and clock_timestamp() >= grant_row.valid_from
        and clock_timestamp() < grant_row.valid_until
    ),
    'status_override',
    (
      select grant_row.status_override
      from public.tenant_billing_grants grant_row
      where grant_row.tenant_id = p_tenant_id
        and grant_row.grant_type = 'billing_access'
        and grant_row.revoked_at is null
        and clock_timestamp() >= grant_row.valid_from
        and clock_timestamp() < grant_row.valid_until
      order by grant_row.valid_until desc, grant_row.created_at desc
      limit 1
    ),
    'leads_bonus',
    coalesce((
      select sum(grant_row.leads_bonus)
      from public.tenant_billing_grants grant_row
      where grant_row.tenant_id = p_tenant_id
        and grant_row.grant_type = 'quota_bonus'
        and grant_row.revoked_at is null
        and clock_timestamp() >= grant_row.valid_from
        and clock_timestamp() < grant_row.valid_until
    ), 0),
    'active_grants',
    (
      select count(*)
      from public.tenant_billing_grants grant_row
      where grant_row.tenant_id = p_tenant_id
        and grant_row.revoked_at is null
        and clock_timestamp() >= grant_row.valid_from
        and clock_timestamp() < grant_row.valid_until
    )
  );
$$;

-- ============================================================
-- CONSULTAS GLOBAIS - SERVICE ROLE
-- ============================================================

create or replace function public.platform_global_metrics(
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  ignored_role text;
  result_value jsonb;
begin
  ignored_role := public.platform_require_admin(
    p_actor_user_id,
    array['viewer', 'operator', 'billing']
  );

  select jsonb_build_object(
    'tenants_total', (select count(*) from public.tenants),
    'tenants_active', (
      select count(*) from public.tenants where status = 'active'
    ),
    'tenants_suspended', (
      select count(*) from public.tenants where status = 'suspended'
    ),
    'tenants_closed', (
      select count(*) from public.tenants where status = 'closed'
    ),
    'users_total', (select count(*) from auth.users),
    'memberships_total', (
      select count(*) from public.tenant_memberships
      where accepted_at is not null
    ),
    'leads_total', (select count(*) from public.leads),
    'leads_last_30_days', (
      select count(*) from public.leads
      where created_at >= clock_timestamp() - interval '30 days'
    ),
    'active_temporary_grants', (
      select count(*) from public.tenant_billing_grants
      where revoked_at is null
        and clock_timestamp() >= valid_from
        and clock_timestamp() < valid_until
    ),
    'generated_at', clock_timestamp()
  ) into result_value;

  return result_value;
end;
$$;

create or replace function public.platform_search_tenants(
  p_actor_user_id uuid,
  p_query text default null,
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  tenant_id uuid,
  name text,
  slug text,
  status text,
  plan_code text,
  subscription_status text,
  members_count bigint,
  leads_count bigint,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  ignored_role text;
begin
  ignored_role := public.platform_require_admin(
    p_actor_user_id,
    array['viewer', 'operator', 'billing']
  );
  if p_status is not null
     and p_status not in ('active', 'suspended', 'closed') then
    raise exception 'Status de tenant inválido';
  end if;

  return query
  select
    tenant.id,
    tenant.name,
    tenant.slug,
    tenant.status,
    subscription.plan_code,
    subscription.status,
    (
      select count(*)
      from public.tenant_memberships membership
      where membership.tenant_id = tenant.id
        and membership.accepted_at is not null
    ),
    (
      select count(*)
      from public.leads lead
      where lead.tenant_id = tenant.id
    ),
    tenant.created_at,
    count(*) over()
  from public.tenants tenant
  left join public.tenant_subscriptions subscription
    on subscription.tenant_id = tenant.id
  where (
      nullif(btrim(coalesce(p_query, '')), '') is null
      or tenant.name ilike
        '%' || nullif(btrim(coalesce(p_query, '')), '') || '%'
      or tenant.slug ilike
        '%' || nullif(btrim(coalesce(p_query, '')), '') || '%'
      or tenant.id::text =
        nullif(btrim(coalesce(p_query, '')), '')
    )
    and (p_status is null or tenant.status = p_status)
  order by tenant.created_at desc, tenant.id
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create or replace function public.platform_get_tenant_detail(
  p_actor_user_id uuid,
  p_tenant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  ignored_role text;
  result_value jsonb;
begin
  ignored_role := public.platform_require_admin(
    p_actor_user_id,
    array['viewer', 'operator', 'billing']
  );

  select jsonb_build_object(
    'tenant', to_jsonb(tenant),
    'subscription', to_jsonb(subscription),
    'current_usage', to_jsonb(usage),
    'members_count', (
      select count(*) from public.tenant_memberships membership
      where membership.tenant_id = tenant.id
        and membership.accepted_at is not null
    ),
    'leads_count', (
      select count(*) from public.leads lead
      where lead.tenant_id = tenant.id
    ),
    'temporary_grants',
      public.platform_effective_billing_grants(tenant.id)
  )
  into result_value
  from public.tenants tenant
  left join public.tenant_subscriptions subscription
    on subscription.tenant_id = tenant.id
  left join lateral (
    select period.*
    from public.tenant_usage_periods period
    where period.tenant_id = tenant.id
      and clock_timestamp() >= period.period_start
      and clock_timestamp() < period.period_end
    order by period.period_start desc
    limit 1
  ) usage on true
  where tenant.id = p_tenant_id;

  if result_value is null then
    raise exception 'Tenant não encontrado';
  end if;
  return result_value;
end;
$$;

create or replace function public.platform_search_users(
  p_actor_user_id uuid,
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  user_id uuid,
  email text,
  name text,
  is_active boolean,
  tenant_count bigint,
  platform_role text,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  ignored_role text;
begin
  ignored_role := public.platform_require_admin(
    p_actor_user_id,
    array['viewer', 'operator', 'billing']
  );

  return query
  select
    auth_user.id,
    auth_user.email::text,
    profile.name,
    profile.is_active,
    (
      select count(*)
      from public.tenant_memberships membership
      where membership.user_id = auth_user.id
        and membership.accepted_at is not null
    ),
    admin.role,
    auth_user.created_at,
    count(*) over()
  from auth.users auth_user
  left join public.profiles profile on profile.id = auth_user.id
  left join public.platform_admins admin
    on admin.user_id = auth_user.id and admin.is_active
  where nullif(btrim(coalesce(p_query, '')), '') is null
    or auth_user.email ilike
      '%' || nullif(btrim(coalesce(p_query, '')), '') || '%'
    or profile.name ilike
      '%' || nullif(btrim(coalesce(p_query, '')), '') || '%'
    or auth_user.id::text =
      nullif(btrim(coalesce(p_query, '')), '')
  order by auth_user.created_at desc, auth_user.id
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- ============================================================
-- MUTAÇÕES ADMINISTRATIVAS - SERVICE ROLE, LOCKS E AUDITORIA
-- ============================================================

create or replace function public.platform_apply_billing_grant(
  p_actor_user_id uuid,
  p_tenant_id uuid,
  p_grant_type text,
  p_status_override text,
  p_leads_bonus integer,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_reason text,
  p_idempotency_key text
)
returns public.tenant_billing_grants
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role_value text;
  grant_row public.tenant_billing_grants;
  request_uuid uuid;
  audit_result record;
begin
  actor_role_value := public.platform_require_admin(
    p_actor_user_id,
    array['billing']
  );
  if btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Chave idempotente é obrigatória';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'Motivo deve ter ao menos 10 caracteres';
  end if;
  if coalesce(p_starts_at, clock_timestamp())
     >= p_ends_at then
    raise exception 'Período do grant é inválido';
  end if;
  begin
    request_uuid := btrim(p_idempotency_key)::uuid;
  exception when invalid_text_representation then
    raise exception 'Chave idempotente deve ser UUID';
  end;
  perform pg_advisory_xact_lock(hashtextextended(request_uuid::text, 0));

  perform 1 from public.tenants
  where id = p_tenant_id
  for update;
  if not found then
    raise exception 'Tenant não encontrado';
  end if;
  select * into grant_row
  from public.tenant_billing_grants
  where idempotency_key = request_uuid::text;
  if found then
    if grant_row.tenant_id is distinct from p_tenant_id
       or grant_row.grant_type is distinct from p_grant_type
       or grant_row.status_override is distinct from p_status_override
       or grant_row.leads_bonus is distinct from p_leads_bonus
       or grant_row.valid_from is distinct from
         coalesce(p_starts_at, grant_row.valid_from)
       or grant_row.valid_until is distinct from p_ends_at
       or grant_row.reason is distinct from btrim(p_reason)
       or grant_row.created_by is distinct from p_actor_user_id then
      raise exception 'Chave idempotente já usada com outros parâmetros';
    end if;
    select * into audit_result
    from public.platform_audit_once(
      request_uuid::text, p_actor_user_id, actor_role_value,
      'billing_grant.applied', 'tenant_billing_grant',
      grant_row.id::text, p_tenant_id, p_reason, null,
      jsonb_build_object(
        'grant_type', p_grant_type,
        'status_override', p_status_override,
        'leads_bonus', p_leads_bonus,
        'starts_at', p_starts_at,
        'ends_at', p_ends_at
      )
    );
    return grant_row;
  end if;
  insert into public.tenant_billing_grants (
    tenant_id,
    grant_type,
    status_override,
    leads_bonus,
    valid_from,
    valid_until,
    reason,
    idempotency_key,
    created_by
  )
  values (
    p_tenant_id,
    p_grant_type,
    p_status_override,
    p_leads_bonus,
    coalesce(p_starts_at, clock_timestamp()),
    p_ends_at,
    btrim(p_reason),
    request_uuid::text,
    p_actor_user_id
  )
  returning * into grant_row;

  select * into audit_result
  from public.platform_audit_once(
    request_uuid::text, p_actor_user_id, actor_role_value,
    'billing_grant.applied', 'tenant_billing_grant',
    grant_row.id::text, p_tenant_id, p_reason, null,
    jsonb_build_object(
      'grant_type', p_grant_type,
      'status_override', p_status_override,
      'leads_bonus', p_leads_bonus,
      'starts_at', p_starts_at,
      'ends_at', p_ends_at
    )
  );

  return grant_row;
end;
$$;

create or replace function public.platform_revoke_billing_grant(
  p_actor_user_id uuid,
  p_grant_id uuid,
  p_reason text
)
returns public.tenant_billing_grants
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role_value text;
  old_row public.tenant_billing_grants;
  grant_row public.tenant_billing_grants;
  audit_result record;
  request_uuid uuid;
begin
  actor_role_value := public.platform_require_admin(
    p_actor_user_id,
    array['billing']
  );
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'Motivo deve ter ao menos 10 caracteres';
  end if;

  select * into old_row
  from public.tenant_billing_grants
  where id = p_grant_id
  for update;
  if not found then
    raise exception 'Grant não encontrado';
  end if;
  request_uuid := md5('platform-revoke:' || p_grant_id::text)::uuid;
  select * into audit_result
  from public.platform_audit_once(
    request_uuid::text, p_actor_user_id, actor_role_value,
    'billing_grant.revoked', 'tenant_billing_grant',
    p_grant_id::text, old_row.tenant_id, p_reason, null,
    jsonb_build_object('revoked', true)
  );
  if audit_result.replayed or old_row.revoked_at is not null then
    return old_row;
  end if;

  update public.tenant_billing_grants
  set revoked_at = clock_timestamp(),
      revoked_by = p_actor_user_id,
      revoke_reason = btrim(p_reason)
  where id = p_grant_id
  returning * into grant_row;

  return grant_row;
end;
$$;

create or replace function public.platform_adjust_tenant_quota(
  p_actor_user_id uuid,
  p_tenant_id uuid,
  p_usage_period_id uuid,
  p_delta integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role_value text;
  usage_row public.tenant_usage_periods;
  old_used integer;
  ledger_id_value bigint;
  audit_result record;
begin
  actor_role_value := public.platform_require_admin(
    p_actor_user_id,
    array['operator', 'billing']
  );
  if coalesce(p_delta, 0) = 0 then
    raise exception 'Ajuste de quota deve ser diferente de zero';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10
     or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Motivo deve ter ao menos 10 caracteres e chave idempotente é obrigatória';
  end if;

  perform 1 from public.tenants
  where id = p_tenant_id
  for update;
  if not found then
    raise exception 'Tenant não encontrado';
  end if;

  select * into usage_row
  from public.tenant_usage_periods period
  where period.tenant_id = p_tenant_id
    and (
      period.id = p_usage_period_id
      or (
        p_usage_period_id is null
        and clock_timestamp() >= period.period_start
        and clock_timestamp() < period.period_end
      )
    )
  order by period.period_start desc
  for update
  limit 1;
  if not found then
    raise exception 'Período de uso não encontrado';
  end if;
  old_used := usage_row.leads_used;

  select * into audit_result
  from public.platform_audit_once(
    p_idempotency_key, p_actor_user_id, actor_role_value,
    'quota.adjusted', 'tenant_usage_period', usage_row.id::text,
    p_tenant_id, p_reason, null,
    jsonb_build_object(
      'quantity', p_delta,
      'usage_period_id', usage_row.id
    )
  );
  if audit_result.replayed then
    return jsonb_build_object(
      'tenant_id', p_tenant_id,
      'usage_period_id', usage_row.id,
      'leads_used_before', (
        select (ledger.metadata ->> 'leads_used_before')::integer
        from public.tenant_usage_ledger ledger
        where ledger.idempotency_key =
          'platform-quota:' || btrim(p_idempotency_key)
      ),
      'leads_used_after', (
        select (ledger.metadata ->> 'leads_used_after')::integer
        from public.tenant_usage_ledger ledger
        where ledger.idempotency_key =
          'platform-quota:' || btrim(p_idempotency_key)
      ),
      'leads_limit', usage_row.leads_limit,
      'idempotent_replay', true
    );
  end if;

  insert into public.tenant_usage_ledger (
    tenant_id,
    usage_period_id,
    event_type,
    quantity,
    idempotency_key,
    metadata
  )
  values (
    p_tenant_id,
    usage_row.id,
    'adjustment',
    -p_delta,
    'platform-quota:' || btrim(p_idempotency_key),
    jsonb_build_object(
      'actor_user_id', p_actor_user_id,
      'reason', btrim(p_reason),
      'quantity', p_delta,
      'leads_used_before', old_used,
      'leads_used_after', old_used - p_delta
    )
  )
  returning id into ledger_id_value;

  if usage_row.leads_used - p_delta < 0
     or usage_row.leads_used - p_delta > usage_row.leads_limit then
    raise exception 'Ajuste produziria uso negativo ou superior à quota';
  end if;

  update public.tenant_usage_periods
  set leads_used = leads_used - p_delta
  where id = usage_row.id
  returning * into usage_row;

  return jsonb_build_object(
    'tenant_id', p_tenant_id,
    'usage_period_id', usage_row.id,
    'leads_used_before', old_used,
    'leads_used_after', usage_row.leads_used,
    'leads_limit', usage_row.leads_limit,
    'idempotent_replay', false
  );
end;
$$;

create or replace function public.platform_reconcile_manual_grant(
  p_tenant_id uuid
)
returns public.tenant_subscriptions
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  subscription_row public.tenant_subscriptions;
  grant_row public.tenant_billing_grants;
  free_start timestamptz;
  free_end timestamptz;
begin
  perform 1
  from public.tenants
  where id = p_tenant_id
  for share;
  if not found then
    raise exception 'Tenant não encontrado';
  end if;

  select * into subscription_row
  from public.tenant_subscriptions
  where tenant_id = p_tenant_id
  for update;

  -- Assinaturas Stripe nunca são alteradas pelo grant local.
  if found and subscription_row.stripe_subscription_id is not null then
    return subscription_row;
  end if;

  select * into grant_row
  from public.tenant_billing_grants grant_item
  where grant_item.tenant_id = p_tenant_id
    and grant_item.grant_type = 'manual_payment'
    and grant_item.revoked_at is null
    and clock_timestamp() >= grant_item.valid_from
    and clock_timestamp() < grant_item.valid_until
  order by
    grant_item.valid_from desc,
    grant_item.created_at desc,
    grant_item.id desc
  for update
  limit 1;

  if found then
    insert into public.tenant_subscriptions (
      tenant_id,
      plan_code,
      stripe_subscription_id,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      canceled_at
    )
    values (
      p_tenant_id,
      grant_row.plan_code,
      null,
      'active',
      grant_row.valid_from,
      grant_row.valid_until,
      false,
      null
    )
    on conflict (tenant_id) do update
    set plan_code = excluded.plan_code,
        status = excluded.status,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = false,
        canceled_at = null
    where public.tenant_subscriptions.stripe_subscription_id is null
    returning * into subscription_row;

    if subscription_row.tenant_id is null then
      select * into subscription_row
      from public.tenant_subscriptions
      where tenant_id = p_tenant_id;
    end if;
    return subscription_row;
  end if;

  -- Sem grant vigente, toda assinatura exclusivamente local volta ao Free.
  if subscription_row.tenant_id is null
     or subscription_row.plan_code <> 'free'
     or subscription_row.current_period_end <= clock_timestamp()
     or subscription_row.status <> 'active' then
    free_start := date_trunc('day', clock_timestamp());
    free_end := free_start + interval '1 month';

    insert into public.tenant_subscriptions (
      tenant_id,
      plan_code,
      stripe_subscription_id,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      canceled_at
    )
    values (
      p_tenant_id,
      'free',
      null,
      'active',
      free_start,
      free_end,
      false,
      null
    )
    on conflict (tenant_id) do update
    set plan_code = 'free',
        status = 'active',
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = false,
        canceled_at = null
    where public.tenant_subscriptions.stripe_subscription_id is null
    returning * into subscription_row;
  end if;

  return subscription_row;
end;
$$;

create or replace function public.platform_reconcile_local_subscriptions()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  tenant_row record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Esta função é exclusiva da service role';
  end if;
  for tenant_row in
    select subscription.tenant_id
    from public.tenant_subscriptions subscription
    where subscription.stripe_subscription_id is null
    order by subscription.tenant_id
  loop
    perform public.platform_reconcile_manual_grant(
      tenant_row.tenant_id
    );
  end loop;
end;
$$;

create or replace function public.prospecta_admin_reconcile_expired_grants(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  tenant_row record;
  processed_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Esta função é exclusiva da service role';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'Limite deve estar entre 1 e 1000';
  end if;

  for tenant_row in
    select subscription.tenant_id
    from public.tenant_subscriptions subscription
    left join lateral (
      select grant_row.plan_code, grant_row.valid_until
      from public.tenant_billing_grants grant_row
      where grant_row.tenant_id = subscription.tenant_id
        and grant_row.grant_type = 'manual_payment'
        and grant_row.revoked_at is null
        and clock_timestamp() >= grant_row.valid_from
        and clock_timestamp() < grant_row.valid_until
      order by
        grant_row.valid_from desc,
        grant_row.created_at desc,
        grant_row.id desc
      limit 1
    ) effective_grant on true
    where subscription.stripe_subscription_id is null
      and (
        subscription.current_period_end <= clock_timestamp()
        or (
          subscription.plan_code <> 'free'
          and effective_grant.plan_code is null
        )
        or (
          effective_grant.plan_code is not null
          and (
            subscription.plan_code <> effective_grant.plan_code
            or subscription.status <> 'active'
            or subscription.current_period_end <>
              effective_grant.valid_until
          )
        )
      )
    order by subscription.tenant_id
    limit p_limit
    for update of subscription skip locked
  loop
    perform public.platform_reconcile_manual_grant(
      tenant_row.tenant_id
    );
    processed_count := processed_count + 1;
  end loop;

  return jsonb_build_object(
    'processed', processed_count,
    'limit', p_limit
  );
end;
$$;

create or replace function public.platform_revoke_grants_on_stripe()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.stripe_subscription_id is not null
     and new.status in ('active', 'trialing', 'past_due', 'unpaid') then
    update public.tenant_billing_grants
    set revoked_at = clock_timestamp(),
        revoked_by = '00000000-0000-0000-0000-000000000000'::uuid,
        revoke_reason =
          'Revogado automaticamente por assinatura Stripe'
    where tenant_id = new.tenant_id
      and grant_type = 'manual_payment'
      and revoked_at is null;

    perform public.platform_reconcile_manual_grant(new.tenant_id);
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_subscriptions_revoke_manual_grants
  on public.tenant_subscriptions;
create trigger tenant_subscriptions_revoke_manual_grants
after insert or update of
  stripe_subscription_id,
  status
on public.tenant_subscriptions
for each row execute function public.platform_revoke_grants_on_stripe();

create or replace function public.prospecta_sync_stripe_subscription(
  p_event_id text,
  p_event_type text,
  p_event_created_at timestamptz,
  p_payload_hash text,
  p_tenant_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_price_id text,
  p_product_id text,
  p_status text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  plan_row public.subscription_plans;
  tenant_customer_id text;
  current_subscription_id text;
  effective_plan_code text;
  effective_status text;
  effective_start timestamptz;
  effective_end timestamptz;
  last_event_created_at timestamptz;
  last_event_type text;
  existing_event public.stripe_webhook_events;
begin
  if btrim(coalesce(p_event_id, '')) = ''
     or btrim(coalesce(p_event_type, '')) = ''
     or btrim(coalesce(p_payload_hash, '')) = ''
     or p_event_created_at is null then
    raise exception 'Evento Stripe inválido';
  end if;

  select tenant.stripe_customer_id into tenant_customer_id
  from public.tenants tenant
  where tenant.id = p_tenant_id
  for update;
  if not found then
    raise exception 'Empresa do evento Stripe não encontrada';
  end if;

  if nullif(btrim(p_customer_id), '') is not null then
    if tenant_customer_id is not null
       and tenant_customer_id <> btrim(p_customer_id) then
      raise exception 'Customer Stripe diverge da empresa';
    end if;
    if exists (
      select 1
      from public.tenants tenant
      where tenant.stripe_customer_id = btrim(p_customer_id)
        and tenant.id <> p_tenant_id
    ) then
      raise exception 'Customer Stripe já pertence a outra empresa';
    end if;
  end if;

  select subscription.stripe_subscription_id
  into current_subscription_id
  from public.tenant_subscriptions subscription
  where subscription.tenant_id = p_tenant_id
  for update;

  if p_event_type <> 'customer.subscription.deleted'
     and nullif(btrim(p_subscription_id), '') is null then
    raise exception 'Subscription Stripe é obrigatória';
  end if;
  if nullif(btrim(p_subscription_id), '') is not null
     and exists (
       select 1
       from public.tenant_subscriptions subscription
       where subscription.stripe_subscription_id =
         btrim(p_subscription_id)
         and subscription.tenant_id <> p_tenant_id
     ) then
    raise exception 'Subscription Stripe já pertence a outra empresa';
  end if;
  if p_event_type = 'customer.subscription.deleted'
     and current_subscription_id is not null
     and nullif(btrim(p_subscription_id), '') is not null
     and current_subscription_id <> btrim(p_subscription_id) then
    raise exception 'Cancelamento refere-se a outra subscription';
  end if;

  insert into public.stripe_webhook_events (
    stripe_event_id, event_type, payload_hash, event_created_at
  )
  values (
    btrim(p_event_id),
    btrim(p_event_type),
    btrim(p_payload_hash),
    p_event_created_at
  )
  on conflict (stripe_event_id) do nothing;

  if not found then
    select * into existing_event
    from public.stripe_webhook_events event_row
    where event_row.stripe_event_id = btrim(p_event_id);

    if existing_event.event_type is distinct from btrim(p_event_type)
       or existing_event.payload_hash is distinct from
         btrim(p_payload_hash)
       or existing_event.event_created_at is distinct from
         p_event_created_at then
      raise exception 'event_id Stripe reutilizado com payload divergente';
    end if;
    return false;
  end if;

  select
    subscription.stripe_last_event_created_at,
    subscription.stripe_last_event_type
  into last_event_created_at, last_event_type
  from public.tenant_subscriptions subscription
  where subscription.tenant_id = p_tenant_id
  for update;

  if last_event_created_at is not null
     and p_event_created_at < last_event_created_at then
    return true;
  end if;
  if last_event_created_at is not null
     and p_event_created_at = last_event_created_at
     and last_event_type = 'customer.subscription.deleted'
     and p_event_type <> 'customer.subscription.deleted' then
    return true;
  end if;

  if nullif(btrim(p_customer_id), '') is not null
     and tenant_customer_id is null then
    update public.tenants
    set stripe_customer_id = btrim(p_customer_id)
    where id = p_tenant_id
      and stripe_customer_id is null;
  end if;

  if p_event_type = 'customer.subscription.deleted' then
    select * into strict plan_row
    from public.subscription_plans
    where code = 'free';
    effective_plan_code := 'free';
    effective_status := 'active';
    effective_start := date_trunc('day', clock_timestamp());
    effective_end := effective_start + interval '1 month';
  else
    select * into plan_row
    from public.subscription_plans plan
    where plan.active
      and (
        plan.stripe_price_id = nullif(btrim(p_price_id), '')
        or plan.stripe_product_id = nullif(btrim(p_product_id), '')
      )
    order by
      case
        when plan.stripe_price_id = nullif(btrim(p_price_id), '')
          then 0
        else 1
      end
    limit 1;

    if not found then
      raise exception 'Preço ou produto Stripe não mapeado';
    end if;
    if nullif(btrim(p_price_id), '') is not null
       and plan_row.stripe_price_id is not null
       and plan_row.stripe_price_id <> btrim(p_price_id) then
      raise exception 'Preço e produto Stripe apontam para planos distintos';
    end if;
    if nullif(btrim(p_product_id), '') is not null
       and plan_row.stripe_product_id is not null
       and plan_row.stripe_product_id <> btrim(p_product_id) then
      raise exception 'Preço e produto Stripe apontam para planos distintos';
    end if;

    if plan_row.stripe_price_id is null
       and nullif(btrim(p_price_id), '') is not null then
      update public.subscription_plans
      set stripe_price_id = btrim(p_price_id)
      where code = plan_row.code
        and stripe_price_id is null;
    end if;

    effective_plan_code := plan_row.code;
    effective_status :=
      coalesce(nullif(btrim(p_status), ''), 'incomplete');
    effective_start := p_period_start;
    effective_end := p_period_end;
  end if;

  if effective_start is null
     or effective_end is null
     or effective_end <= effective_start then
    raise exception 'Período Stripe inválido';
  end if;

  insert into public.tenant_subscriptions (
    tenant_id,
    plan_code,
    stripe_subscription_id,
    status,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    canceled_at,
    stripe_last_event_created_at,
    stripe_last_event_type
  )
  values (
    p_tenant_id,
    effective_plan_code,
    case
      when effective_plan_code = 'free' then null
      else btrim(p_subscription_id)
    end,
    effective_status,
    effective_start,
    effective_end,
    case
      when effective_plan_code = 'free' then false
      else coalesce(p_cancel_at_period_end, false)
    end,
    case
      when p_event_type = 'customer.subscription.deleted'
        then clock_timestamp()
      else null
    end,
    p_event_created_at,
    btrim(p_event_type)
  )
  on conflict (tenant_id) do update
  set plan_code = excluded.plan_code,
      stripe_subscription_id = excluded.stripe_subscription_id,
      status = excluded.status,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end,
      canceled_at = excluded.canceled_at,
      stripe_last_event_created_at =
        excluded.stripe_last_event_created_at,
      stripe_last_event_type =
        excluded.stripe_last_event_type;

  insert into public.tenant_usage_periods (
    tenant_id,
    period_start,
    period_end,
    leads_limit
  )
  values (
    p_tenant_id,
    effective_start,
    effective_end,
    plan_row.leads_per_month
  )
  on conflict (tenant_id, period_start, period_end) do update
  set leads_limit = excluded.leads_limit;

  return true;
end;
$$;

create or replace function public.prospecta_admin_begin_external_operation(
  p_operation_id uuid,
  p_actor_id uuid,
  p_tenant_id uuid,
  p_action text,
  p_payload jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role_value text;
  operation_row public.platform_external_operations;
  audit_result record;
  expected_payload jsonb;
begin
  if not (
    coalesce(p_action, '') like 'billing.%'
    or p_action in ('auth.block', 'auth.unblock')
  ) then
    raise exception 'Ação externa não suportada';
  end if;
  actor_role_value := public.platform_require_admin(
    p_actor_id,
    case
      when p_action like 'billing.%' then array['billing']
      else array['operator', 'billing']
    end
  );
  if btrim(coalesce(p_action, '')) = ''
     or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'Ação e payload objeto são obrigatórios';
  end if;
  expected_payload := jsonb_build_object(
    'action', btrim(p_action),
    'payload', p_payload,
    'status', 'pending'
  );
  perform pg_advisory_xact_lock(
    hashtextextended(p_operation_id::text, 0)
  );

  select * into operation_row
  from public.platform_external_operations operation
  where operation.operation_id = p_operation_id
  for update;

  if found then
    if operation_row.actor_user_id is distinct from p_actor_id
       or operation_row.tenant_id is distinct from p_tenant_id
       or operation_row.action is distinct from btrim(p_action)
       or operation_row.payload is distinct from p_payload then
      raise exception 'operation_id já usado com parâmetros divergentes';
    end if;
  else
    insert into public.platform_external_operations (
      operation_id, actor_user_id, tenant_id, action, payload
    )
    values (
      p_operation_id, p_actor_id, p_tenant_id, btrim(p_action), p_payload
    )
    returning * into operation_row;
  end if;

  select * into audit_result
  from public.platform_audit_once(
    p_operation_id::text,
    p_actor_id,
    actor_role_value,
    'external_operation.begin',
    'platform_external_operation',
    p_operation_id::text,
    p_tenant_id,
    p_reason,
    null,
    expected_payload
  );

  return to_jsonb(operation_row) || jsonb_build_object(
    'idempotent_replay', audit_result.replayed
  );
end;
$$;

create or replace function public.prospecta_admin_complete_external_operation(
  p_operation_id uuid,
  p_actor_id uuid,
  p_result jsonb,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role_value text;
  operation_row public.platform_external_operations;
  audit_result record;
  expected_payload jsonb;
begin
  select * into operation_row
  from public.platform_external_operations operation
  where operation.operation_id = p_operation_id
  for update;
  if not found then
    raise exception 'Operação externa não encontrada';
  end if;
  actor_role_value := public.platform_require_admin(
    p_actor_id,
    case
      when operation_row.action like 'billing.%' then array['billing']
      when operation_row.action in ('auth.block', 'auth.unblock')
        then array['operator', 'billing']
      else array[]::text[]
    end
  );

  expected_payload := jsonb_build_object(
    'status', 'succeeded',
    'result', p_result
  );
  select * into audit_result
  from public.platform_audit_once(
    p_request_id::text,
    p_actor_id,
    actor_role_value,
    'external_operation.complete',
    'platform_external_operation',
    p_operation_id::text,
    operation_row.tenant_id,
    p_reason,
    null,
    expected_payload
  );
  if audit_result.replayed then
    return to_jsonb(operation_row) ||
      jsonb_build_object('idempotent_replay', true);
  end if;
  if operation_row.status <> 'pending' then
    raise exception 'Operação externa já foi finalizada';
  end if;

  update public.platform_external_operations
  set status = 'succeeded',
      result = p_result,
      error = null,
      completed_at = clock_timestamp()
  where operation_id = p_operation_id
  returning * into operation_row;

  return to_jsonb(operation_row) ||
    jsonb_build_object('idempotent_replay', false);
end;
$$;

create or replace function public.prospecta_admin_fail_external_operation(
  p_operation_id uuid,
  p_actor_id uuid,
  p_error text,
  p_result jsonb,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role_value text;
  operation_row public.platform_external_operations;
  audit_result record;
  expected_payload jsonb;
begin
  if btrim(coalesce(p_error, '')) = '' then
    raise exception 'Erro da operação externa é obrigatório';
  end if;
  select * into operation_row
  from public.platform_external_operations operation
  where operation.operation_id = p_operation_id
  for update;
  if not found then
    raise exception 'Operação externa não encontrada';
  end if;
  actor_role_value := public.platform_require_admin(
    p_actor_id,
    case
      when operation_row.action like 'billing.%' then array['billing']
      when operation_row.action in ('auth.block', 'auth.unblock')
        then array['operator', 'billing']
      else array[]::text[]
    end
  );

  expected_payload := jsonb_build_object(
    'status', 'failed',
    'result', p_result,
    'error', btrim(p_error)
  );
  select * into audit_result
  from public.platform_audit_once(
    p_request_id::text,
    p_actor_id,
    actor_role_value,
    'external_operation.fail',
    'platform_external_operation',
    p_operation_id::text,
    operation_row.tenant_id,
    p_reason,
    null,
    expected_payload
  );
  if audit_result.replayed then
    return to_jsonb(operation_row) ||
      jsonb_build_object('idempotent_replay', true);
  end if;
  if operation_row.status <> 'pending' then
    raise exception 'Operação externa já foi finalizada';
  end if;

  update public.platform_external_operations
  set status = 'failed',
      result = p_result,
      error = btrim(p_error),
      completed_at = clock_timestamp()
  where operation_id = p_operation_id
  returning * into operation_row;

  return to_jsonb(operation_row) ||
    jsonb_build_object('idempotent_replay', false);
end;
$$;

create or replace function public.prospecta_admin_list_pending_auth_operations(
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  result_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Esta função é exclusiva da service role';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'Limite deve estar entre 1 e 1000';
  end if;

  select jsonb_build_object(
    'items', coalesce(jsonb_agg(to_jsonb(operation_row)
      order by operation_row.created_at, operation_row.operation_id),
      '[]'::jsonb),
    'count', count(*)
  )
  into result_value
  from (
    select operation.*
    from public.platform_external_operations operation
    where operation.status = 'pending'
      and operation.action in ('auth.block', 'auth.unblock')
    order by operation.created_at, operation.operation_id
    limit p_limit
  ) operation_row;

  return result_value;
end;
$$;

-- ============================================================
-- CONTRATOS RPC CONSUMIDOS PELAS EDGE FUNCTIONS DO PAINEL
-- ============================================================

create or replace function public.prospecta_admin_get_metrics()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  result_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Esta função é exclusiva da service role';
  end if;
  with effective_subscriptions as (
    select
      subscription.tenant_id,
      case
        when subscription.stripe_subscription_id is null
             and grant_row.id is not null
          then grant_row.plan_code
        when subscription.stripe_subscription_id is null
             and grant_row.id is null
             and subscription.current_period_end <= clock_timestamp()
          then 'free'
        else subscription.plan_code
      end as plan_code,
      case
        when subscription.stripe_subscription_id is null
             and (
               grant_row.id is not null
               or subscription.current_period_end <= clock_timestamp()
             )
          then 'active'
        else subscription.status
      end as status
    from public.tenant_subscriptions subscription
    left join lateral (
      select grant_item.id, grant_item.plan_code
      from public.tenant_billing_grants grant_item
      where grant_item.tenant_id = subscription.tenant_id
        and grant_item.grant_type = 'manual_payment'
        and grant_item.revoked_at is null
        and clock_timestamp() >= grant_item.valid_from
        and clock_timestamp() < grant_item.valid_until
      order by
        grant_item.valid_from desc,
        grant_item.created_at desc,
        grant_item.id desc
      limit 1
    ) grant_row on true
  )
  select jsonb_build_object(
    'tenants_total', (select count(*) from public.tenants),
    'tenants_active', (
      select count(*) from public.tenants where status = 'active'
    ),
    'tenants_suspended', (
      select count(*) from public.tenants where status = 'suspended'
    ),
    'users_total', (select count(*) from auth.users),
    'subscriptions_active', (
      select count(*) from effective_subscriptions
      where status in ('active', 'trialing')
    ),
    'subscriptions_past_due', (
      select count(*) from effective_subscriptions
      where status = 'past_due'
    ),
    'mrr_estimate_cents', coalesce((
      select sum(plan.monthly_price_cents)
      from effective_subscriptions subscription
      join public.subscription_plans plan
        on plan.code = subscription.plan_code
      where subscription.status in ('active', 'trialing')
    ), 0),
    'leads_used_month', coalesce((
      select sum(period.leads_used)
      from public.tenant_usage_periods period
      where clock_timestamp() >= period.period_start
        and clock_timestamp() < period.period_end
    ), 0),
    'subscriptions_by_plan', coalesce((
      select jsonb_object_agg(grouped.plan_code, grouped.total)
      from (
        select plan.code as plan_code, count(subscription.tenant_id) as total
        from public.subscription_plans plan
        left join effective_subscriptions subscription
          on subscription.plan_code = plan.code
        group by plan.code
      ) grouped
    ), '{}'::jsonb),
    'subscriptions_by_status', coalesce((
      select jsonb_object_agg(grouped.status, grouped.total)
      from (
        select subscription.status, count(*) as total
        from effective_subscriptions subscription
        group by subscription.status
      ) grouped
    ), '{}'::jsonb)
  ) into result_value;

  return result_value;
end;
$$;

create or replace function public.prospecta_admin_get_identity(
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  role_value text;
begin
  role_value := public.platform_require_admin(
    p_actor_id,
    array['viewer', 'operator', 'billing']
  );
  return jsonb_build_object('role', role_value);
end;
$$;

create or replace function public.prospecta_admin_list_tenants(
  p_search text,
  p_plan_code text,
  p_tenant_status text,
  p_subscription_status text,
  p_page integer,
  p_page_size integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  result_value jsonb;
  search_value text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Esta função é exclusiva da service role';
  end if;
  if p_tenant_status is not null
     and p_tenant_status not in ('active', 'suspended', 'closed') then
    raise exception 'Status de tenant inválido';
  end if;
  if length(coalesce(p_search, '')) > 200 then
    raise exception 'Busca deve ter no máximo 200 caracteres';
  end if;
  if p_plan_code is not null and not exists (
    select 1
    from public.subscription_plans plan
    where plan.code = p_plan_code
  ) then
    raise exception 'Plano inválido';
  end if;
  if length(coalesce(p_subscription_status, '')) > 50 then
    raise exception 'Status de assinatura inválido';
  end if;
  search_value := nullif(btrim(coalesce(p_search, '')), '');

  with filtered as (
    select
      tenant.id as tenant_id,
      tenant.name,
      tenant.slug,
      tenant.status as tenant_status,
      effective.plan_code,
      effective.status as subscription_status,
      tenant.stripe_customer_id,
      subscription.stripe_subscription_id,
      coalesce(usage.leads_used, 0) as leads_used,
      coalesce(usage.leads_limit, plan.leads_per_month, 0) as leads_limit,
      (
        select count(*)
        from public.tenant_memberships membership
        where membership.tenant_id = tenant.id
          and membership.accepted_at is not null
      ) as users_used,
      coalesce((to_jsonb(plan) ->> 'user_limit')::integer, 1)
        as user_limit,
      owner.owner_email,
      tenant.created_at
    from public.tenants tenant
    left join public.tenant_subscriptions subscription
      on subscription.tenant_id = tenant.id
    left join lateral (
      select
        grant_item.id,
        grant_item.plan_code
      from public.tenant_billing_grants grant_item
      where grant_item.tenant_id = tenant.id
        and grant_item.grant_type = 'manual_payment'
        and grant_item.revoked_at is null
        and clock_timestamp() >= grant_item.valid_from
        and clock_timestamp() < grant_item.valid_until
      order by
        grant_item.valid_from desc,
        grant_item.created_at desc,
        grant_item.id desc
      limit 1
    ) grant_row on true
    left join lateral (
      select
        case
          when subscription.stripe_subscription_id is null
               and grant_row.id is not null
            then grant_row.plan_code
          when subscription.stripe_subscription_id is null
               and grant_row.id is null
               and subscription.current_period_end <= clock_timestamp()
            then 'free'
          else subscription.plan_code
        end as plan_code,
        case
          when subscription.stripe_subscription_id is null
               and (
                 grant_row.id is not null
                 or subscription.current_period_end <= clock_timestamp()
               )
            then 'active'
          else subscription.status
        end as status
    ) effective on true
    left join public.subscription_plans plan
      on plan.code = effective.plan_code
    left join lateral (
      select auth_user.email::text as owner_email
      from public.tenant_memberships membership
      join auth.users auth_user on auth_user.id = membership.user_id
      where membership.tenant_id = tenant.id
        and membership.role = 'owner'
        and membership.accepted_at is not null
      order by membership.created_at, membership.user_id
      limit 1
    ) owner on true
    left join lateral (
      select period.*
      from public.tenant_usage_periods period
      where period.tenant_id = tenant.id
        and clock_timestamp() >= period.period_start
        and clock_timestamp() < period.period_end
      order by period.period_start desc
      limit 1
    ) usage on true
    where (
      search_value is null
      or tenant.name ilike '%' || search_value || '%'
      or tenant.slug ilike '%' || search_value || '%'
      or owner.owner_email ilike '%' || search_value || '%'
      or tenant.stripe_customer_id ilike '%' || search_value || '%'
      or subscription.stripe_subscription_id
        ilike '%' || search_value || '%'
      or tenant.id::text = search_value
    )
      and (
        p_plan_code is null
        or effective.plan_code = p_plan_code
      )
      and (
        p_tenant_status is null
        or tenant.status = p_tenant_status
      )
      and (
        p_subscription_status is null
        or effective.status = p_subscription_status
      )
  ),
  paged as (
    select *
    from filtered
    order by created_at desc, tenant_id
    limit greatest(1, least(coalesce(p_page_size, 25), 100))
    offset (
      greatest(coalesce(p_page, 1), 1) - 1
    ) * greatest(1, least(coalesce(p_page_size, 25), 100))
  )
  select jsonb_build_object(
    'items', coalesce(
      (select jsonb_agg(to_jsonb(paged)) from paged),
      '[]'::jsonb
    ),
    'page', greatest(coalesce(p_page, 1), 1),
    'page_size', greatest(1, least(coalesce(p_page_size, 25), 100)),
    'total', (select count(*) from filtered)
  ) into result_value;

  return result_value;
end;
$$;

-- Compatibilidade com a Edge anterior, que enviava apenas status do tenant.
create or replace function public.prospecta_admin_list_tenants(
  p_search text default null,
  p_status text default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.prospecta_admin_list_tenants(
    p_search,
    null,
    p_status,
    null,
    p_page,
    p_page_size
  );
$$;

create or replace function public.prospecta_admin_get_tenant(
  p_tenant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  result_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Esta função é exclusiva da service role';
  end if;

  select jsonb_build_object(
    'tenant', to_jsonb(tenant),
    'subscription', to_jsonb(subscription),
    'usage', to_jsonb(usage),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', membership.user_id,
        'email', auth_user.email,
        'name', coalesce(profile.name, split_part(auth_user.email, '@', 1)),
        'position', to_jsonb(profile) ->> 'position',
        'phone', to_jsonb(profile) ->> 'phone',
        'is_active', profile.is_active,
        'tenant_role', membership.role,
        'last_sign_in_at', auth_user.last_sign_in_at
      ) order by profile.name, auth_user.email)
      from public.tenant_memberships membership
      join auth.users auth_user on auth_user.id = membership.user_id
      left join public.profiles profile on profile.id = membership.user_id
      where membership.tenant_id = tenant.id
        and membership.accepted_at is not null
    ), '[]'::jsonb),
    'grants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', grant_row.id,
        'grant_type', grant_row.grant_type,
        'plan_code', grant_row.plan_code,
        'valid_from', grant_row.valid_from,
        'valid_until', grant_row.valid_until,
        'reason', grant_row.reason,
        'revoked_at', grant_row.revoked_at
      ) order by grant_row.created_at desc)
      from public.tenant_billing_grants grant_row
      where grant_row.tenant_id = tenant.id
        and grant_row.grant_type in ('manual_payment', 'billing_exempt')
    ), '[]'::jsonb),
    'recent_audit', coalesce((
      select jsonb_agg(to_jsonb(audit_row)
        order by audit_row.created_at desc)
      from (
        select
          audit.id,
          actor.email::text as actor_email,
          audit.action,
          coalesce(audit.reason, '') as reason,
          audit.created_at,
          audit.payload_before,
          audit.payload_after
        from public.platform_audit_log audit
        left join auth.users actor on actor.id = audit.actor_user_id
        where audit.tenant_id = tenant.id
        order by audit.created_at desc
        limit 50
      ) audit_row
    ), '[]'::jsonb),
    'stripe', null
  ) into result_value
  from public.tenants tenant
  left join public.tenant_subscriptions subscription
    on subscription.tenant_id = tenant.id
  left join lateral (
    select period.*
    from public.tenant_usage_periods period
    where period.tenant_id = tenant.id
      and clock_timestamp() >= period.period_start
      and clock_timestamp() < period.period_end
    order by period.period_start desc
    limit 1
  ) usage on true
  where tenant.id = p_tenant_id;

  if result_value is null then
    raise exception 'Tenant não encontrado';
  end if;
  return result_value;
end;
$$;

create or replace function public.prospecta_admin_list_users(
  p_search text default null,
  p_tenant_id uuid default null,
  p_is_active boolean default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  result_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Esta função é exclusiva da service role';
  end if;

  with filtered as (
    select
      auth_user.id as user_id,
      auth_user.email::text,
      coalesce(profile.name, split_part(auth_user.email, '@', 1)) as name,
      profile.is_active,
      membership.tenant_id,
      tenant.name as tenant_name,
      membership.role as tenant_role,
      to_jsonb(profile) ->> 'position' as position,
      to_jsonb(profile) ->> 'phone' as phone,
      auth_user.last_sign_in_at
    from auth.users auth_user
    join public.profiles profile on profile.id = auth_user.id
    join public.tenant_memberships membership
      on membership.user_id = auth_user.id
     and membership.accepted_at is not null
    join public.tenants tenant on tenant.id = membership.tenant_id
    where (
      nullif(btrim(coalesce(p_search, '')), '') is null
      or auth_user.email ilike '%' || btrim(p_search) || '%'
      or profile.name ilike '%' || btrim(p_search) || '%'
      or auth_user.id::text = btrim(p_search)
    )
      and (p_tenant_id is null or membership.tenant_id = p_tenant_id)
      and (p_is_active is null or profile.is_active = p_is_active)
  ),
  paged as (
    select *
    from filtered
    order by name, email, tenant_id
    limit greatest(1, least(coalesce(p_page_size, 25), 100))
    offset (
      greatest(coalesce(p_page, 1), 1) - 1
    ) * greatest(1, least(coalesce(p_page_size, 25), 100))
  )
  select jsonb_build_object(
    'items', coalesce(
      (select jsonb_agg(to_jsonb(paged)) from paged),
      '[]'::jsonb
    ),
    'page', greatest(coalesce(p_page, 1), 1),
    'page_size', greatest(1, least(coalesce(p_page_size, 25), 100)),
    'total', (select count(*) from filtered)
  ) into result_value;

  return result_value;
end;
$$;

create or replace function public.prospecta_admin_update_tenant(
  p_tenant_id uuid,
  p_patch jsonb,
  p_reason text,
  p_actor_id uuid,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role_value text;
  old_row public.tenants;
  new_row public.tenants;
  new_name text;
  new_slug text;
  new_status text;
  audit_result record;
begin
  actor_role_value := public.platform_require_admin(
    p_actor_id,
    array['operator', 'billing']
  );
  if length(btrim(coalesce(p_reason, ''))) < 10
     or btrim(coalesce(p_request_id, '')) = '' then
    raise exception 'Motivo deve ter ao menos 10 caracteres e request_id é obrigatório';
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object'
     or p_patch = '{}'::jsonb
     or exists (
       select 1
       from jsonb_object_keys(p_patch) key_name
       where key_name not in ('name', 'slug', 'status')
     ) then
    raise exception 'Patch de tenant inválido';
  end if;

  select * into old_row
  from public.tenants
  where id = p_tenant_id
  for update;
  if not found then
    raise exception 'Tenant não encontrado';
  end if;

  select * into audit_result
  from public.platform_audit_once(
    p_request_id, p_actor_id, actor_role_value,
    'tenant.updated', 'tenant', p_tenant_id::text,
    p_tenant_id, p_reason, null, p_patch
  );
  if audit_result.replayed then
    return jsonb_build_object('tenant_id', p_tenant_id);
  end if;

  new_name := case
    when p_patch ? 'name' then nullif(btrim(p_patch ->> 'name'), '')
    else old_row.name
  end;
  new_slug := case
    when p_patch ? 'slug' then nullif(btrim(p_patch ->> 'slug'), '')
    else old_row.slug
  end;
  new_status := case
    when p_patch ? 'status' then p_patch ->> 'status'
    else old_row.status
  end;

  if new_name is null
     or new_slug is null
     or new_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or new_status not in ('active', 'suspended', 'closed') then
    raise exception 'Nome, slug ou status inválido';
  end if;

  update public.tenants
  set name = new_name,
      slug = new_slug,
      status = new_status
  where id = p_tenant_id
  returning * into new_row;

  return jsonb_build_object('tenant_id', p_tenant_id);
end;
$$;

drop function if exists public.prospecta_admin_update_user(
  uuid, jsonb, text, uuid, text
);

create or replace function public.prospecta_admin_update_user(
  p_tenant_id uuid,
  p_user_id uuid,
  p_patch jsonb,
  p_reason text,
  p_actor_id uuid,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role_value text;
  old_profile public.profiles;
  new_profile public.profiles;
  membership_row public.tenant_memberships;
  subscription_row public.tenant_subscriptions;
  plan_row public.subscription_plans;
  requested_role text;
  admins_used_value integer;
  before_payload jsonb;
  after_payload jsonb;
  audit_result record;
begin
  actor_role_value := public.platform_require_admin(
    p_actor_id,
    array['operator', 'billing']
  );
  if length(btrim(coalesce(p_reason, ''))) < 10
     or btrim(coalesce(p_request_id, '')) = '' then
    raise exception 'Motivo deve ter ao menos 10 caracteres e request_id é obrigatório';
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object'
     or p_patch = '{}'::jsonb
     or exists (
       select 1
       from jsonb_object_keys(p_patch) key_name
       where key_name not in ('name', 'position', 'phone', 'tenant_role')
     ) then
    raise exception 'Patch de usuário inválido';
  end if;
  if p_patch ? 'name'
     and nullif(btrim(p_patch ->> 'name'), '') is null then
    raise exception 'Nome do usuário não pode ficar vazio';
  end if;

  select * into old_profile
  from public.profiles
  where id = p_user_id
  for update;
  if not found then
    raise exception 'Usuário não encontrado';
  end if;

  select * into membership_row
  from public.tenant_memberships
  where tenant_id = p_tenant_id
    and user_id = p_user_id
    and accepted_at is not null
  for update;
  if not found then
    raise exception 'Usuário não pertence ao tenant informado';
  end if;

  select * into audit_result
  from public.platform_audit_once(
    p_request_id, p_actor_id, actor_role_value,
    'user.updated', 'user', p_user_id::text,
    p_tenant_id, p_reason, null, p_patch
  );
  if audit_result.replayed then
    return jsonb_build_object(
      'user_id', p_user_id,
      'tenant_id', p_tenant_id
    );
  end if;

  if p_patch ? 'tenant_role' then
    if membership_row.role = 'owner' then
      raise exception 'O papel owner não pode ser alterado por esta operação';
    end if;

    requested_role := p_patch ->> 'tenant_role';
    if requested_role not in ('admin', 'member') then
      raise exception 'Papel de tenant inválido';
    end if;
    if requested_role = 'admin' and membership_row.role <> 'admin' then
      select * into strict subscription_row
      from public.tenant_subscriptions
      where tenant_id = p_tenant_id
      for update;

      select * into strict plan_row
      from public.subscription_plans
      where code = subscription_row.plan_code
        and active;

      select count(*) into admins_used_value
      from public.tenant_memberships membership
      where membership.tenant_id = p_tenant_id
        and membership.accepted_at is not null
        and membership.role = 'admin'
        and membership.user_id <> p_user_id;

      if admins_used_value >= coalesce(
        (to_jsonb(plan_row) ->> 'admin_limit')::integer,
        0
      ) then
        raise exception 'Limite de administradores do plano atingido';
      end if;
    end if;
  end if;

  before_payload := jsonb_build_object(
    'profile', to_jsonb(old_profile),
    'tenant_id', p_tenant_id,
    'tenant_role', membership_row.role
  );

  update public.profiles
  set name = case
        when p_patch ? 'name'
          then coalesce(nullif(btrim(p_patch ->> 'name'), ''), name)
        else name
      end,
      position = case
        when p_patch ? 'position'
          then nullif(btrim(p_patch ->> 'position'), '')
        else position
      end,
      phone = case
        when p_patch ? 'phone'
          then nullif(btrim(p_patch ->> 'phone'), '')
        else phone
      end
  where id = p_user_id
  returning * into new_profile;

  if requested_role is not null then
    update public.tenant_memberships
    set role = requested_role::public.tenant_role
    where tenant_id = p_tenant_id
      and user_id = p_user_id
    returning * into membership_row;
  end if;

  after_payload := jsonb_build_object(
    'profile', to_jsonb(new_profile),
    'tenant_id', p_tenant_id,
    'tenant_role', membership_row.role
  );

  return jsonb_build_object(
    'user_id', p_user_id,
    'tenant_id', p_tenant_id
  );
end;
$$;

create or replace function public.prospecta_admin_log_action(
  p_actor_id uuid,
  p_action text,
  p_tenant_id uuid,
  p_reason text,
  p_request_id text,
  p_payload_before jsonb default null,
  p_payload_after jsonb default null
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role_value text;
  audit_id_value bigint;
begin
  actor_role_value := public.platform_require_admin(
    p_actor_id,
    case
      when coalesce(p_action, '') like 'billing.%'
        then array['billing']
      else array['operator', 'billing']
    end
  );
  if btrim(coalesce(p_action, '')) = ''
     or length(btrim(coalesce(p_reason, ''))) < 10
     or btrim(coalesce(p_request_id, '')) = '' then
    raise exception 'Ação/request_id são obrigatórios e motivo deve ter ao menos 10 caracteres';
  end if;

  select result.audit_id into audit_id_value
  from public.platform_audit_once(
    p_request_id,
    p_actor_id,
    actor_role_value,
    btrim(p_action),
    'tenant',
    p_tenant_id::text,
    p_tenant_id,
    p_reason,
    p_payload_before,
    p_payload_after
  ) result;

  return audit_id_value;
end;
$$;

create or replace function public.prospecta_admin_set_tenant_status(
  p_tenant_id uuid,
  p_status text,
  p_reason text,
  p_actor_id uuid,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role_value text;
  old_row public.tenants;
  new_row public.tenants;
  audit_result record;
begin
  actor_role_value := public.platform_require_admin(
    p_actor_id,
    array['operator']
  );
  if p_status not in ('active', 'suspended', 'closed') then
    raise exception 'Status de tenant inválido';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10
     or btrim(coalesce(p_request_id, '')) = '' then
    raise exception 'Motivo deve ter ao menos 10 caracteres e request_id é obrigatório';
  end if;
  select * into old_row
  from public.tenants
  where id = p_tenant_id
  for update;
  if not found then
    raise exception 'Tenant não encontrado';
  end if;
  select * into audit_result
  from public.platform_audit_once(
    p_request_id, p_actor_id, actor_role_value,
    'tenant.status_changed', 'tenant', p_tenant_id::text,
    p_tenant_id, p_reason, null,
    jsonb_build_object('status', p_status)
  );
  if audit_result.replayed then
    return jsonb_build_object(
      'tenant_id', p_tenant_id,
      'status', old_row.status
    );
  end if;

  update public.tenants
  set status = p_status
  where id = p_tenant_id
  returning * into new_row;

  return jsonb_build_object(
    'tenant_id', p_tenant_id,
    'status', new_row.status
  );
end;
$$;

drop function if exists public.prospecta_admin_set_user_active(
  uuid, boolean, text, uuid, text
);

create or replace function public.prospecta_admin_set_user_active(
  p_tenant_id uuid,
  p_user_id uuid,
  p_is_active boolean,
  p_reason text,
  p_actor_id uuid,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role_value text;
  old_active boolean;
  audit_result record;
begin
  actor_role_value := public.platform_require_admin(
    p_actor_id,
    array['operator', 'billing']
  );
  if length(btrim(coalesce(p_reason, ''))) < 10
     or btrim(coalesce(p_request_id, '')) = '' then
    raise exception 'Motivo deve ter ao menos 10 caracteres e request_id é obrigatório';
  end if;
  if not p_is_active and p_user_id = p_actor_id then
    raise exception 'Não é permitido bloquear o próprio administrador';
  end if;
  if not p_is_active and exists (
    select 1
    from public.platform_admins admin
    where admin.user_id = p_user_id
  ) then
    raise exception 'Platform admins não podem ser bloqueados por esta operação';
  end if;

  select profile.is_active into old_active
  from public.profiles profile
  where profile.id = p_user_id
  for update;
  if not found then
    raise exception 'Usuário não encontrado';
  end if;
  if not exists (
    select 1
    from public.tenant_memberships membership
    where membership.tenant_id = p_tenant_id
      and membership.user_id = p_user_id
      and membership.accepted_at is not null
  ) then
    raise exception 'Usuário não pertence ao tenant informado';
  end if;
  select * into audit_result
  from public.platform_audit_once(
    p_request_id, p_actor_id, actor_role_value,
    'user.active_changed', 'user', p_user_id::text,
    p_tenant_id, p_reason, null,
    jsonb_build_object('is_active', p_is_active)
  );
  if audit_result.replayed then
    return jsonb_build_object(
      'user_id', p_user_id,
      'tenant_id', p_tenant_id,
      'is_active', old_active
    );
  end if;

  update public.profiles
  set is_active = p_is_active
  where id = p_user_id;

  return jsonb_build_object(
    'user_id', p_user_id,
    'tenant_id', p_tenant_id,
    'is_active', p_is_active
  );
end;
$$;

create or replace function public.prospecta_admin_create_billing_grant(
  p_tenant_id uuid,
  p_grant_type text,
  p_plan_code text,
  p_valid_until timestamptz,
  p_reason text,
  p_actor_id uuid,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role_value text;
  grant_row public.tenant_billing_grants;
  subscription_row public.tenant_subscriptions;
  plan_row public.subscription_plans;
  audit_result record;
  request_uuid uuid;
begin
  actor_role_value := public.platform_require_admin(
    p_actor_id,
    array['billing']
  );
  if p_grant_type not in ('manual_payment', 'billing_exempt')
     or length(btrim(coalesce(p_reason, ''))) < 10
     or btrim(coalesce(p_request_id, '')) = '' then
    raise exception 'Dados do grant são inválidos';
  end if;
  if not exists (
    select 1 from public.subscription_plans
    where code = p_plan_code and active
  ) then
    raise exception 'Plano inválido ou inativo';
  end if;
  begin
    request_uuid := btrim(p_request_id)::uuid;
  exception when invalid_text_representation then
    raise exception 'request_id deve ser UUID';
  end;
  perform pg_advisory_xact_lock(hashtextextended(request_uuid::text, 0));

  select * into grant_row
  from public.tenant_billing_grants
  where idempotency_key = btrim(p_request_id);
  if found then
    if grant_row.tenant_id is distinct from p_tenant_id
       or grant_row.grant_type is distinct from p_grant_type
       or grant_row.plan_code is distinct from p_plan_code
       or grant_row.valid_until is distinct from p_valid_until
       or grant_row.reason is distinct from btrim(p_reason)
       or grant_row.created_by is distinct from p_actor_id then
      raise exception 'request_id já usado com outros parâmetros';
    end if;
    select * into audit_result
    from public.platform_audit_once(
      request_uuid::text, p_actor_id, actor_role_value,
      'billing_grant.created', 'tenant_billing_grant',
      grant_row.id::text, p_tenant_id, p_reason, null,
      jsonb_build_object(
        'grant_type', p_grant_type,
        'plan_code', p_plan_code,
        'valid_until', p_valid_until
      )
    );
    return jsonb_build_object('grant_id', grant_row.id);
  end if;
  if p_valid_until <= clock_timestamp() then
    raise exception 'Validade do grant deve estar no futuro';
  end if;

  perform 1 from public.tenants
  where id = p_tenant_id
  for update;
  if not found then
    raise exception 'Tenant não encontrado';
  end if;
  select * into subscription_row
  from public.tenant_subscriptions
  where tenant_id = p_tenant_id
  for update;
  if found and subscription_row.stripe_subscription_id is not null then
    raise exception 'Grant manual não pode substituir assinatura Stripe';
  end if;

  insert into public.tenant_billing_grants (
    tenant_id, grant_type, plan_code, valid_from, valid_until,
    reason, idempotency_key, created_by
  )
  values (
    p_tenant_id, p_grant_type, p_plan_code, clock_timestamp(),
    p_valid_until, btrim(p_reason), btrim(p_request_id), p_actor_id
  )
  returning * into grant_row;

  select * into audit_result
  from public.platform_audit_once(
    request_uuid::text, p_actor_id, actor_role_value,
    'billing_grant.created', 'tenant_billing_grant',
    grant_row.id::text, p_tenant_id, p_reason, null,
    jsonb_build_object(
      'grant_type', p_grant_type,
      'plan_code', p_plan_code,
      'valid_until', p_valid_until
    )
  );

  subscription_row :=
    public.platform_reconcile_manual_grant(p_tenant_id);
  select * into strict plan_row
  from public.subscription_plans
  where code = subscription_row.plan_code
    and active;

  insert into public.tenant_usage_periods (
    tenant_id,
    period_start,
    period_end,
    leads_limit
  )
  values (
    p_tenant_id,
    subscription_row.current_period_start,
    subscription_row.current_period_end,
    plan_row.leads_per_month
  )
  on conflict (tenant_id, period_start, period_end) do update
  set leads_limit = excluded.leads_limit;

  return jsonb_build_object('grant_id', grant_row.id);
end;
$$;

create or replace function public.prospecta_admin_revoke_billing_grant(
  p_tenant_id uuid,
  p_grant_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role_value text;
  old_row public.tenant_billing_grants;
  grant_row public.tenant_billing_grants;
  subscription_row public.tenant_subscriptions;
  plan_row public.subscription_plans;
  audit_result record;
begin
  actor_role_value := public.platform_require_admin(
    p_actor_id,
    array['billing']
  );
  if length(btrim(coalesce(p_reason, ''))) < 10
     or btrim(coalesce(p_request_id, '')) = '' then
    raise exception 'Motivo deve ter ao menos 10 caracteres e request_id é obrigatório';
  end if;
  perform 1
  from public.tenants
  where id = p_tenant_id
  for update;
  if not found then
    raise exception 'Tenant não encontrado';
  end if;
  select * into old_row
  from public.tenant_billing_grants
  where id = p_grant_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'Grant não encontrado';
  end if;
  select * into audit_result
  from public.platform_audit_once(
    p_request_id, p_actor_id, actor_role_value,
    'billing_grant.revoked', 'tenant_billing_grant',
    p_grant_id::text, p_tenant_id, p_reason, null,
    jsonb_build_object('revoked', true)
  );
  if audit_result.replayed or old_row.revoked_at is not null then
    grant_row := old_row;
  else
    update public.tenant_billing_grants
    set revoked_at = clock_timestamp(),
        revoked_by = p_actor_id,
        revoke_reason = btrim(p_reason)
    where id = p_grant_id
    returning * into grant_row;
  end if;

  if grant_row.grant_type = 'manual_payment' then
    subscription_row :=
      public.platform_reconcile_manual_grant(p_tenant_id);
    select * into strict plan_row
    from public.subscription_plans
    where code = subscription_row.plan_code
      and active;

    insert into public.tenant_usage_periods (
      tenant_id,
      period_start,
      period_end,
      leads_limit
    )
    values (
      p_tenant_id,
      subscription_row.current_period_start,
      subscription_row.current_period_end,
      plan_row.leads_per_month
    )
    on conflict (tenant_id, period_start, period_end) do update
    set leads_limit = excluded.leads_limit;
  end if;

  return jsonb_build_object('grant_id', grant_row.id, 'revoked', true);
end;
$$;

create or replace function public.prospecta_admin_adjust_quota(
  p_tenant_id uuid,
  p_delta integer,
  p_reason text,
  p_actor_id uuid,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return public.platform_adjust_tenant_quota(
    p_actor_id,
    p_tenant_id,
    null,
    p_delta,
    p_reason,
    p_request_id
  );
end;
$$;

-- ============================================================
-- BLOQUEIO DE TENANTS SUSPENSOS/FECHADOS
-- ============================================================

-- Assinatura preservada conforme o SQL vigente do LeadFlow.
-- prospecta_insert_leads_with_quota(uuid,jsonb,text) sempre chama esta função.
-- prospecta_request_command(uuid,text,text) chama esta função ao iniciar
-- ("rodando"). Pausar/parar permanece disponível por segurança operacional.
create or replace function public.prospecta_ensure_usage_period(
  p_tenant_id uuid
)
returns public.tenant_usage_periods
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  tenant_status_value text;
  subscription_row public.tenant_subscriptions;
  plan_row public.subscription_plans;
  usage_row public.tenant_usage_periods;
begin
  select tenant.status into tenant_status_value
  from public.tenants tenant
  where tenant.id = p_tenant_id
  for share;

  if tenant_status_value is null then
    raise exception 'Empresa não encontrada';
  end if;
  if tenant_status_value in ('suspended', 'closed') then
    raise exception 'Empresa suspensa ou encerrada';
  end if;

  subscription_row :=
    public.platform_reconcile_manual_grant(p_tenant_id);

  if subscription_row.status not in ('active', 'trialing') then
    raise exception 'Assinatura sem permissão para gerar leads';
  end if;
  if clock_timestamp() < subscription_row.current_period_start
     or clock_timestamp() >= subscription_row.current_period_end then
    raise exception 'Período da assinatura expirado ou ainda não iniciado';
  end if;

  select * into plan_row
  from public.subscription_plans
  where code = subscription_row.plan_code
    and active;
  if not found then
    raise exception 'Plano da assinatura não está disponível';
  end if;

  insert into public.tenant_usage_periods (
    tenant_id,
    period_start,
    period_end,
    leads_limit
  )
  values (
    p_tenant_id,
    subscription_row.current_period_start,
    subscription_row.current_period_end,
    plan_row.leads_per_month
  )
  on conflict (tenant_id, period_start, period_end) do update
  set leads_limit = excluded.leads_limit
  returning * into usage_row;

  return usage_row;
end;
$$;

-- Implementação SaaS vigente, preservada com gate obrigatório de quota.
create or replace function public.prospecta_insert_leads_with_quota(
  p_bot_id uuid,
  p_leads jsonb,
  p_batch_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  config_row public.prospecta_bot_configs;
  subscription_row public.tenant_subscriptions;
  usage_row public.tenant_usage_periods;
  prior_result jsonb;
  requested_count integer;
  inserted_count integer := 0;
  inserted_leads jsonb := '[]'::jsonb;
  processed_leads jsonb := '[]'::jsonb;
  remaining_before integer;
  result_value jsonb;
begin
  if jsonb_typeof(p_leads) <> 'array' then
    raise exception 'O lote de leads deve ser uma lista JSON';
  end if;
  if btrim(coalesce(p_batch_key, '')) = '' then
    raise exception 'A chave idempotente do lote é obrigatória';
  end if;

  requested_count := jsonb_array_length(p_leads);
  if requested_count < 1 or requested_count > 100 then
    raise exception 'O lote deve conter entre 1 e 100 leads';
  end if;

  select * into config_row
  from public.prospecta_bot_configs
  where id = p_bot_id
    and deleted_at is null;

  if not found or config_row.tenant_id is null then
    raise exception 'Bot não encontrado ou sem empresa vinculada';
  end if;

  if auth.uid() is not null
     and not public.is_tenant_member(config_row.tenant_id) then
    raise exception 'Acesso negado ao bot';
  end if;

  -- Gate obrigatório antes de qualquer leitura/inserção do lote.
  usage_row :=
    public.prospecta_ensure_usage_period(config_row.tenant_id);

  select * into subscription_row
  from public.tenant_subscriptions
  where tenant_id = config_row.tenant_id;

  if subscription_row.status not in ('active', 'trialing') then
    raise exception 'Assinatura sem permissão para gerar leads';
  end if;

  select * into usage_row
  from public.tenant_usage_periods
  where id = usage_row.id
  for update;

  select batch.result into prior_result
  from public.prospecta_lead_import_batches batch
  where batch.tenant_id = config_row.tenant_id
    and batch.batch_key = p_batch_key;
  if found then
    return prior_result;
  end if;

  remaining_before :=
    greatest(usage_row.leads_limit - usage_row.leads_used, 0);

  if remaining_before > 0 then
    with incoming as (
      select lead_data, ordinal
      from jsonb_array_elements(p_leads)
        with ordinality as item(lead_data, ordinal)
      where btrim(coalesce(lead_data ->> 'name', '')) <> ''
      order by ordinal
    ),
    normalized as (
      select
        lead_data,
        ordinal,
        encode(
          digest(
            lower(regexp_replace(
              btrim(lead_data ->> 'name'),
              '[^[:alnum:]]+',
              ' ',
              'g'
            ))
            || '|' || coalesce(btrim(lead_data ->> 'phone'), ''),
            'sha256'
          ),
          'hex'
        ) as generated_key
      from incoming
    ),
    candidates as (
      select normalized.*
      from normalized
      where not exists (
        select 1
        from public.leads existing
        where existing.tenant_id = config_row.tenant_id
          and existing.dedupe_key = normalized.generated_key
      )
      order by ordinal
      limit remaining_before
    ),
    processed as (
      select normalized.*
      from normalized
      where exists (
        select 1
        from public.leads existing
        where existing.tenant_id = config_row.tenant_id
          and existing.dedupe_key = normalized.generated_key
      )
      or exists (
        select 1
        from candidates candidate
        where candidate.generated_key = normalized.generated_key
      )
    ),
    inserted as (
      insert into public.leads (
        tenant_id,
        name,
        company,
        email,
        phone,
        city,
        website,
        instagram,
        source,
        estimated_value,
        niche,
        first_contact_message,
        owner_id,
        google_maps_url,
        stage_id,
        dedupe_key
      )
      select
        config_row.tenant_id,
        btrim(lead_data ->> 'name'),
        nullif(btrim(lead_data ->> 'company'), ''),
        nullif(btrim(lead_data ->> 'email'), ''),
        nullif(btrim(lead_data ->> 'phone'), ''),
        nullif(btrim(lead_data ->> 'city'), ''),
        nullif(btrim(lead_data ->> 'website'), ''),
        nullif(btrim(lead_data ->> 'instagram'), ''),
        coalesce(
          nullif(btrim(lead_data ->> 'source'), ''),
          config_row.niche
        ),
        coalesce((lead_data ->> 'estimated_value')::numeric, 0),
        coalesce(
          nullif(btrim(lead_data ->> 'niche'), ''),
          config_row.niche
        ),
        coalesce(
          nullif(btrim(lead_data ->> 'first_contact_message'), ''),
          config_row.initial_message
        ),
        case
          when public.is_tenant_member(
            config_row.tenant_id,
            config_row.lead_owner_id
          ) then config_row.lead_owner_id
          else null
        end,
        nullif(btrim(lead_data ->> 'google_maps_url'), ''),
        (
          select stage.id
          from public.lead_stages stage
          where stage.tenant_id = config_row.tenant_id
            and stage.id = case
              when coalesce(lead_data ->> 'stage_id', '')
                ~ '^[0-9a-fA-F-]{36}$'
              then (lead_data ->> 'stage_id')::uuid
              else null
            end
          limit 1
        ),
        generated_key
      from candidates
      on conflict (tenant_id, dedupe_key)
        where dedupe_key is not null
      do nothing
      returning name, phone
    )
    select
      count(*),
      coalesce(
        jsonb_agg(jsonb_build_object('name', name, 'phone', phone)),
        '[]'::jsonb
      ),
      coalesce(
        (
          select jsonb_agg(jsonb_build_object(
            'name', lead_data ->> 'name',
            'phone', lead_data ->> 'phone'
          ))
          from processed
        ),
        '[]'::jsonb
      )
    into inserted_count, inserted_leads, processed_leads
    from inserted;
  end if;

  if inserted_count > 0 then
    update public.tenant_usage_periods
    set leads_used = leads_used + inserted_count
    where id = usage_row.id;

    insert into public.tenant_usage_ledger (
      tenant_id,
      usage_period_id,
      event_type,
      quantity,
      idempotency_key,
      metadata
    )
    values (
      config_row.tenant_id,
      usage_row.id,
      'lead_import',
      inserted_count,
      'lead-import:' || config_row.tenant_id || ':' || p_batch_key,
      jsonb_build_object('bot_id', p_bot_id)
    );
  end if;

  result_value := jsonb_build_object(
    'requested', requested_count,
    'inserted', inserted_count,
    'inserted_leads', inserted_leads,
    'processed_leads', processed_leads,
    'remaining', greatest(remaining_before - inserted_count, 0),
    'limit_reached', remaining_before <= inserted_count,
    'plan_code', subscription_row.plan_code,
    'period_end', subscription_row.current_period_end
  );

  insert into public.prospecta_lead_import_batches (
    tenant_id, batch_key, bot_id, result
  )
  values (
    config_row.tenant_id, p_batch_key, p_bot_id, result_value
  );

  return result_value;
end;
$$;

-- Implementação SaaS vigente, preservada com gate ao iniciar o bot.
create or replace function public.prospecta_request_command(
  p_bot_id uuid,
  p_command text,
  p_target_runner_id text default null
)
returns setof public.prospecta_bot_controls
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  tenant_id_value uuid;
  billing_status jsonb;
begin
  if p_command not in ('rodando', 'pausado', 'parado') then
    raise exception 'Comando inválido';
  end if;
  if not public.prospecta_can_access_bot(p_bot_id) then
    raise exception 'Acesso negado ao bot';
  end if;

  select tenant_id into tenant_id_value
  from public.prospecta_bot_configs
  where id = p_bot_id and deleted_at is null;

  if p_command = 'rodando' then
    select jsonb_build_object(
      'status', subscription.status,
      'remaining', greatest(usage.leads_limit - usage.leads_used, 0)
    )
    into billing_status
    from public.tenant_subscriptions subscription
    join lateral (
      select ensured.*
      from public.prospecta_ensure_usage_period(tenant_id_value) ensured
    ) usage on true
    where subscription.tenant_id = tenant_id_value;

    if coalesce(billing_status ->> 'status', '') not in (
      'active', 'trialing'
    ) then
      raise exception 'Assinatura sem permissão para gerar leads';
    end if;
    if coalesce((billing_status ->> 'remaining')::integer, 0) <= 0 then
      raise exception 'Limite mensal de leads atingido';
    end if;
  end if;

  return query
  insert into public.prospecta_bot_controls (
    bot_id,
    tenant_id,
    command,
    target_runner_id,
    request_id,
    requested_at,
    acknowledged_at
  )
  values (
    p_bot_id,
    tenant_id_value,
    p_command,
    nullif(btrim(p_target_runner_id), ''),
    gen_random_uuid(),
    clock_timestamp(),
    null
  )
  on conflict (bot_id) do update
  set tenant_id = excluded.tenant_id,
      command = excluded.command,
      target_runner_id = excluded.target_runner_id,
      request_id = excluded.request_id,
      requested_at = excluded.requested_at,
      acknowledged_at = null
  returning prospecta_bot_controls.*;
end;
$$;

create or replace function public.prospecta_get_billing_status()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  tenant_id_value uuid;
  subscription_row public.tenant_subscriptions;
  usage_row public.tenant_usage_periods;
  plan_row public.subscription_plans;
  users_used_value integer;
  admins_used_value integer;
begin
  tenant_id_value := public.current_tenant_id();
  if tenant_id_value is null then
    return null;
  end if;

  subscription_row :=
    public.platform_reconcile_manual_grant(tenant_id_value);

  select * into strict plan_row
  from public.subscription_plans
  where code = subscription_row.plan_code;

  insert into public.tenant_usage_periods (
    tenant_id,
    period_start,
    period_end,
    leads_limit
  )
  values (
    tenant_id_value,
    subscription_row.current_period_start,
    subscription_row.current_period_end,
    plan_row.leads_per_month
  )
  on conflict (tenant_id, period_start, period_end) do update
  set leads_limit = excluded.leads_limit
  returning * into usage_row;

  select
    count(*),
    count(*) filter (where membership.role = 'admin')
  into users_used_value, admins_used_value
  from public.tenant_memberships membership
  where membership.tenant_id = tenant_id_value
    and membership.accepted_at is not null;

  return jsonb_build_object(
    'tenant_id', tenant_id_value,
    'plan_code', subscription_row.plan_code,
    'plan_name', plan_row.name,
    'status', subscription_row.status,
    'monthly_price_cents', plan_row.monthly_price_cents,
    'leads_limit', usage_row.leads_limit,
    'leads_used', usage_row.leads_used,
    'leads_remaining', greatest(
      usage_row.leads_limit - usage_row.leads_used,
      0
    ),
    'user_limit',
      coalesce((to_jsonb(plan_row) ->> 'user_limit')::integer, 1),
    'users_used', users_used_value,
    'users_remaining', greatest(
      coalesce((to_jsonb(plan_row) ->> 'user_limit')::integer, 1)
        - users_used_value,
      0
    ),
    'admin_limit',
      coalesce((to_jsonb(plan_row) ->> 'admin_limit')::integer, 0),
    'admins_used', admins_used_value,
    'admins_remaining', greatest(
      coalesce((to_jsonb(plan_row) ->> 'admin_limit')::integer, 0)
        - admins_used_value,
      0
    ),
    'current_period_start', subscription_row.current_period_start,
    'current_period_end', subscription_row.current_period_end,
    'cancel_at_period_end', subscription_row.cancel_at_period_end
  );
end;
$$;

-- ============================================================
-- PERMISSÕES
-- ============================================================

revoke all on function public.platform_touch_admin()
  from public, anon, authenticated;
revoke all on function public.platform_reject_audit_mutation()
  from public, anon, authenticated;
revoke all on function public.platform_require_admin(uuid, text[])
  from public, anon, authenticated;
revoke all on function public.platform_audit_once(
  text, uuid, text, text, text, text, uuid, text, jsonb, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function public.platform_effective_billing_grants(uuid)
  from public, anon, authenticated;
revoke all on function public.platform_global_metrics(uuid)
  from public, anon, authenticated;
revoke all on function public.platform_search_tenants(
  uuid, text, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.platform_get_tenant_detail(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.platform_search_users(
  uuid, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.platform_apply_billing_grant(
  uuid, uuid, text, text, integer, timestamptz, timestamptz, text, text
) from public, anon, authenticated;
revoke all on function public.platform_revoke_billing_grant(
  uuid, uuid, text
) from public, anon, authenticated;
revoke all on function public.platform_adjust_tenant_quota(
  uuid, uuid, uuid, integer, text, text
) from public, anon, authenticated;
revoke all on function public.platform_reconcile_manual_grant(uuid)
  from public, anon, authenticated;
revoke all on function public.platform_reconcile_local_subscriptions()
  from public, anon, authenticated, service_role;
revoke all on function public.prospecta_admin_reconcile_expired_grants(
  integer
) from public, anon, authenticated;
revoke all on function public.platform_revoke_grants_on_stripe()
  from public, anon, authenticated;
revoke all on function public.prospecta_admin_get_metrics()
  from public, anon, authenticated;
revoke all on function public.prospecta_admin_get_identity(uuid)
  from public, anon, authenticated;
revoke all on function public.prospecta_admin_list_tenants(
  text, text, text, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_list_tenants(
  text, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_get_tenant(uuid)
  from public, anon, authenticated;
revoke all on function public.prospecta_admin_list_users(
  text, uuid, boolean, integer, integer
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_update_tenant(
  uuid, jsonb, text, uuid, text
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_update_user(
  uuid, uuid, jsonb, text, uuid, text
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_log_action(
  uuid, text, uuid, text, text, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_set_tenant_status(
  uuid, text, text, uuid, text
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_set_user_active(
  uuid, uuid, boolean, text, uuid, text
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_create_billing_grant(
  uuid, text, text, timestamptz, text, uuid, text
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_revoke_billing_grant(
  uuid, uuid, text, uuid, text
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_adjust_quota(
  uuid, integer, text, uuid, text
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_begin_external_operation(
  uuid, uuid, uuid, text, jsonb, text
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_complete_external_operation(
  uuid, uuid, jsonb, text, uuid
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_fail_external_operation(
  uuid, uuid, text, jsonb, text, uuid
) from public, anon, authenticated;
revoke all on function public.prospecta_admin_list_pending_auth_operations(
  integer
) from public, anon, authenticated;
revoke all on function public.prospecta_sync_stripe_subscription(
  text, text, timestamptz, text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, boolean
) from public, anon, authenticated;

grant execute on function public.platform_global_metrics(uuid)
  to service_role;
grant execute on function public.platform_audit_once(
  text, uuid, text, text, text, text, uuid, text, jsonb, jsonb, jsonb
) to service_role;
grant execute on function public.platform_search_tenants(
  uuid, text, text, integer, integer
) to service_role;
grant execute on function public.platform_get_tenant_detail(uuid, uuid)
  to service_role;
grant execute on function public.platform_search_users(
  uuid, text, integer, integer
) to service_role;
grant execute on function public.platform_apply_billing_grant(
  uuid, uuid, text, text, integer, timestamptz, timestamptz, text, text
) to service_role;
grant execute on function public.platform_revoke_billing_grant(
  uuid, uuid, text
) to service_role;
grant execute on function public.platform_adjust_tenant_quota(
  uuid, uuid, uuid, integer, text, text
) to service_role;
grant execute on function public.platform_reconcile_manual_grant(uuid)
  to service_role;
grant execute on function public.prospecta_admin_reconcile_expired_grants(
  integer
) to service_role;
grant select on table public.platform_admins to service_role;
grant execute on function public.prospecta_admin_get_metrics()
  to service_role;
grant execute on function public.prospecta_admin_get_identity(uuid)
  to service_role;
grant execute on function public.prospecta_admin_list_tenants(
  text, text, text, text, integer, integer
) to service_role;
grant execute on function public.prospecta_admin_list_tenants(
  text, text, integer, integer
) to service_role;
grant execute on function public.prospecta_admin_get_tenant(uuid)
  to service_role;
grant execute on function public.prospecta_admin_list_users(
  text, uuid, boolean, integer, integer
) to service_role;
grant execute on function public.prospecta_admin_update_tenant(
  uuid, jsonb, text, uuid, text
) to service_role;
grant execute on function public.prospecta_admin_update_user(
  uuid, uuid, jsonb, text, uuid, text
) to service_role;
grant execute on function public.prospecta_admin_log_action(
  uuid, text, uuid, text, text, jsonb, jsonb
) to service_role;
grant execute on function public.prospecta_admin_set_tenant_status(
  uuid, text, text, uuid, text
) to service_role;
grant execute on function public.prospecta_admin_set_user_active(
  uuid, uuid, boolean, text, uuid, text
) to service_role;
grant execute on function public.prospecta_admin_create_billing_grant(
  uuid, text, text, timestamptz, text, uuid, text
) to service_role;
grant execute on function public.prospecta_admin_revoke_billing_grant(
  uuid, uuid, text, uuid, text
) to service_role;
grant execute on function public.prospecta_admin_adjust_quota(
  uuid, integer, text, uuid, text
) to service_role;
grant execute on function public.prospecta_admin_begin_external_operation(
  uuid, uuid, uuid, text, jsonb, text
) to service_role;
grant execute on function public.prospecta_admin_complete_external_operation(
  uuid, uuid, jsonb, text, uuid
) to service_role;
grant execute on function public.prospecta_admin_fail_external_operation(
  uuid, uuid, text, jsonb, text, uuid
) to service_role;
grant execute on function public.prospecta_admin_list_pending_auth_operations(
  integer
) to service_role;
grant execute on function public.prospecta_sync_stripe_subscription(
  text, text, timestamptz, text, uuid, text, text, text, text, text,
  timestamptz, timestamptz, boolean
) to service_role;

-- Mantém as permissões legadas da função redefinida.
revoke all on function public.prospecta_ensure_usage_period(uuid)
  from public, anon, authenticated;
grant execute on function public.prospecta_ensure_usage_period(uuid)
  to service_role;
revoke all on function public.prospecta_insert_leads_with_quota(
  uuid, jsonb, text
) from public, anon;
grant execute on function public.prospecta_insert_leads_with_quota(
  uuid, jsonb, text
) to authenticated, service_role;
revoke all on function public.prospecta_request_command(
  uuid, text, text
) from public, anon, authenticated;
grant execute on function public.prospecta_request_command(
  uuid, text, text
) to authenticated, service_role;
revoke all on function public.prospecta_get_billing_status()
  from public, anon;
grant execute on function public.prospecta_get_billing_status()
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
