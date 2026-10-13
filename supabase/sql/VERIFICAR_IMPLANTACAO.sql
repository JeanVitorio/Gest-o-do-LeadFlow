-- LeadFlow - verificação somente leitura da camada do painel global.
-- Este arquivo contém apenas SELECTs e não altera dados nem metadados.

-- 1. Objetos obrigatórios.
select
  object_name,
  to_regclass('public.' || object_name) is not null as installed
from (
  values
    ('platform_admins'),
    ('platform_audit_log'),
    ('tenant_billing_grants'),
    ('platform_external_operations'),
    ('stripe_webhook_events')
) expected(object_name)
order by object_name;

-- 1.1. Colunas necessárias para ordenação e mapeamento dos webhooks Stripe.
select
  table_name,
  column_name,
  data_type
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'tenant_subscriptions'
      and column_name in (
        'stripe_last_event_created_at',
        'stripe_last_event_type'
      ))
    or
    (table_name = 'subscription_plans'
      and column_name = 'stripe_product_id')
  )
order by table_name, column_name;

-- 2. Funções e assinaturas esperadas.
with expected(signature) as (
  values
    ('platform_global_metrics(uuid)'),
    ('platform_search_tenants(uuid,text,text,integer,integer)'),
    ('platform_get_tenant_detail(uuid,uuid)'),
    ('platform_search_users(uuid,text,integer,integer)'),
    (
      'platform_apply_billing_grant('
      || 'uuid,uuid,text,text,integer,timestamp with time zone,'
      || 'timestamp with time zone,text,text)'
    ),
    ('platform_revoke_billing_grant(uuid,uuid,text)'),
    (
      'platform_adjust_tenant_quota('
      || 'uuid,uuid,uuid,integer,text,text)'
    ),
    ('platform_reconcile_manual_grant(uuid)'),
    ('platform_reconcile_local_subscriptions()'),
    ('prospecta_admin_reconcile_expired_grants(integer)'),
    (
      'platform_audit_once('
      || 'text,uuid,text,text,text,text,uuid,text,jsonb,jsonb,jsonb)'
    ),
    ('prospecta_admin_get_metrics()'),
    ('prospecta_admin_get_identity(uuid)'),
    (
      'prospecta_admin_list_tenants('
      || 'text,text,text,text,integer,integer)'
    ),
    ('prospecta_admin_list_tenants(text,text,integer,integer)'),
    ('prospecta_admin_get_tenant(uuid)'),
    ('prospecta_admin_list_users(text,uuid,boolean,integer,integer)'),
    (
      'prospecta_admin_update_tenant('
      || 'uuid,jsonb,text,uuid,text)'
    ),
    (
      'prospecta_admin_update_user('
      || 'uuid,uuid,jsonb,text,uuid,text)'
    ),
    (
      'prospecta_admin_log_action('
      || 'uuid,text,uuid,text,text,jsonb,jsonb)'
    ),
    (
      'prospecta_admin_set_tenant_status('
      || 'uuid,text,text,uuid,text)'
    ),
    (
      'prospecta_admin_set_user_active('
      || 'uuid,uuid,boolean,text,uuid,text)'
    ),
    (
      'prospecta_admin_create_billing_grant('
      || 'uuid,text,text,timestamp with time zone,text,uuid,text)'
    ),
    (
      'prospecta_admin_revoke_billing_grant('
      || 'uuid,uuid,text,uuid,text)'
    ),
    (
      'prospecta_admin_adjust_quota('
      || 'uuid,integer,text,uuid,text)'
    ),
    (
      'prospecta_admin_begin_external_operation('
      || 'uuid,uuid,uuid,text,jsonb,text)'
    ),
    (
      'prospecta_admin_complete_external_operation('
      || 'uuid,uuid,jsonb,text,uuid)'
    ),
    (
      'prospecta_admin_fail_external_operation('
      || 'uuid,uuid,text,jsonb,text,uuid)'
    ),
    ('prospecta_admin_list_pending_auth_operations(integer)'),
    (
      'prospecta_sync_stripe_subscription('
      || 'text,text,timestamp with time zone,text,uuid,text,text,text,'
      || 'text,text,timestamp with time zone,timestamp with time zone,'
      || 'boolean)'
    ),
    ('prospecta_get_billing_status()'),
    ('prospecta_ensure_usage_period(uuid)'),
    ('prospecta_request_command(uuid,text,text)'),
    ('prospecta_insert_leads_with_quota(uuid,jsonb,text)')
)
select
  expected.signature,
  to_regprocedure('public.' || expected.signature) is not null
    as installed
from expected
order by expected.signature;

-- 3. RLS habilitado nas tabelas administrativas.
select
  class.relname as table_name,
  class.relrowsecurity as rls_enabled,
  count(policy.policyname) as policy_count
from pg_class class
join pg_namespace namespace on namespace.oid = class.relnamespace
left join pg_policies policy
  on policy.schemaname = namespace.nspname
 and policy.tablename = class.relname
where namespace.nspname = 'public'
  and class.relname in (
    'platform_admins',
    'platform_audit_log',
    'tenant_billing_grants',
    'platform_external_operations',
    'stripe_webhook_events'
  )
group by class.relname, class.relrowsecurity
order by class.relname;

-- 4. authenticated/anon não devem ter privilégios nas tabelas globais.
select
  grantee,
  table_name,
  privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'platform_admins',
    'platform_audit_log',
    'tenant_billing_grants',
    'platform_external_operations',
    'stripe_webhook_events'
  )
  and grantee in ('anon', 'authenticated', 'PUBLIC')
order by grantee, table_name, privilege_type;

-- Resultado esperado da consulta 4: zero linhas.

-- 5. Apenas service_role deve receber EXECUTE nas RPCs administrativas.
select
  routine_name,
  grantee,
  privilege_type
from information_schema.role_routine_grants
where specific_schema = 'public'
  and (
    routine_name like 'platform_%'
    or routine_name like 'prospecta_admin_%'
    or routine_name = 'prospecta_sync_stripe_subscription'
  )
  and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
order by routine_name, grantee;

-- 6. Nenhuma RPC administrativa pode ser executável pelo frontend.
select
  procedure.oid::regprocedure::text as function_signature,
  has_function_privilege(
    'anon',
    procedure.oid,
    'EXECUTE'
  ) as anon_can_execute,
  has_function_privilege(
    'authenticated',
    procedure.oid,
    'EXECUTE'
  ) as authenticated_can_execute,
  has_function_privilege(
    'service_role',
    procedure.oid,
    'EXECUTE'
  ) as service_role_can_execute
from pg_proc procedure
join pg_namespace namespace on namespace.oid = procedure.pronamespace
where namespace.nspname = 'public'
  and (
    procedure.proname like 'prospecta_admin_%'
    or procedure.proname = 'prospecta_sync_stripe_subscription'
  )
order by procedure.oid::regprocedure::text;

-- Esperado: anon/authenticated false e service_role true em todas.

-- 7. Trigger que torna a auditoria imutável.
select
  trigger_name,
  event_manipulation,
  action_timing,
  action_statement
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table = 'platform_audit_log'
order by trigger_name, event_manipulation;

-- 8. Índices administrativos.
select
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in (
    'platform_admins',
    'platform_audit_log',
    'tenant_billing_grants',
    'platform_external_operations',
    'stripe_webhook_events',
    'tenants',
    'tenant_subscriptions',
    'tenant_memberships'
  )
order by tablename, indexname;

-- 9. Regras de motivo mínimo aplicadas a novos registros.
select
  class.relname as table_name,
  constraint_row.conname as constraint_name,
  constraint_row.convalidated as validated_for_existing_rows,
  pg_get_constraintdef(constraint_row.oid) as definition
from pg_constraint constraint_row
join pg_class class on class.oid = constraint_row.conrelid
join pg_namespace namespace on namespace.oid = class.relnamespace
where namespace.nspname = 'public'
  and constraint_row.conname in (
    'platform_audit_reason_valid',
    'tenant_billing_grants_reason_not_blank'
  )
order by class.relname;

-- 10. Confirma que o bloqueio de status está na função central chamada
-- pelas duas RPCs legadas, sem executar nenhuma delas.
select
  position(
    'suspended' in pg_get_functiondef(procedure.oid)
  ) > 0
  and position(
    'closed' in pg_get_functiondef(procedure.oid)
  ) > 0 as tenant_status_block_installed
from pg_proc procedure
join pg_namespace namespace on namespace.oid = procedure.pronamespace
where namespace.nspname = 'public'
  and procedure.proname = 'prospecta_ensure_usage_period'
  and pg_get_function_identity_arguments(procedure.oid) = 'p_tenant_id uuid';

-- 11. Sanidade dos dados e grants temporários vigentes.
select
  (select count(*) from public.platform_admins) as platform_admins,
  (
    select count(*) from public.platform_admins
    where is_active and role = 'viewer'
  ) as active_viewers,
  (
    select count(*) from public.platform_admins
    where is_active and role = 'operator'
  ) as active_operators,
  (
    select count(*) from public.platform_admins
    where is_active and role = 'billing'
  ) as active_billing_admins,
  (
    select count(*) from public.tenant_billing_grants
    where revoked_at is null
      and clock_timestamp() >= valid_from
      and clock_timestamp() < valid_until
  ) as active_temporary_grants,
  (select count(*) from public.platform_audit_log) as audit_events;

-- 12. Violações que devem permanecer zeradas.
select 'expired_grant_marked_active' as check_name, count(*) as violations
from public.tenant_billing_grants
where revoked_at is null
  and valid_until <= valid_from
union all
select 'invalid_platform_admin_role', count(*)
from public.platform_admins
where role not in ('viewer', 'operator', 'billing')
union all
select 'audit_without_action', count(*)
from public.platform_audit_log
where btrim(action) = '' or btrim(target_type) = ''
union all
select 'new_audit_with_short_reason', count(*)
from public.platform_audit_log
where reason is not null
  and length(btrim(reason)) < 10
union all
select 'grant_with_short_reason', count(*)
from public.tenant_billing_grants
where length(btrim(reason)) < 10
union all
select 'manual_grant_with_stripe_subscription', count(*)
from public.tenant_billing_grants grant_row
join public.tenant_subscriptions subscription
  on subscription.tenant_id = grant_row.tenant_id
where grant_row.grant_type = 'manual_payment'
  and grant_row.revoked_at is null
  and clock_timestamp() >= grant_row.valid_from
  and clock_timestamp() < grant_row.valid_until
  and subscription.stripe_subscription_id is not null
union all
select 'active_manual_grant_plan_mismatch', count(*)
from public.tenant_subscriptions subscription
join lateral (
  select grant_item.*
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
where subscription.stripe_subscription_id is null
  and (
    subscription.plan_code <> grant_row.plan_code
    or subscription.status <> 'active'
    or subscription.current_period_end <> grant_row.valid_until
  );

-- 13. Semântica esperada da quota: quantity positiva reduz leads_used.
select
  position(
    'leads_used - p_delta' in pg_get_functiondef(procedure.oid)
  ) > 0 as positive_quantity_returns_balance,
  position(
    'leads_used_before' in pg_get_functiondef(procedure.oid)
  ) > 0 as returns_before,
  position(
    'leads_used_after' in pg_get_functiondef(procedure.oid)
  ) > 0 as returns_after
from pg_proc procedure
join pg_namespace namespace on namespace.oid = procedure.pronamespace
where namespace.nspname = 'public'
  and procedure.proname = 'platform_adjust_tenant_quota'
  and pg_get_function_identity_arguments(procedure.oid) =
    'p_actor_user_id uuid, p_tenant_id uuid, p_usage_period_id uuid, '
    || 'p_delta integer, p_reason text, p_idempotency_key text';

-- 14. Assinaturas antigas sem tenant explícito devem ter sido removidas.
select
  to_regprocedure(
    'public.prospecta_admin_update_user(uuid,jsonb,text,uuid,text)'
  ) is null as old_update_user_removed,
  to_regprocedure(
    'public.prospecta_admin_set_user_active(uuid,boolean,text,uuid,text)'
  ) is null as old_set_user_active_removed;

-- 15. Matriz operator/billing nas quatro operações finais.
with expected(function_name) as (
  values
    ('prospecta_admin_update_tenant'),
    ('prospecta_admin_update_user'),
    ('prospecta_admin_set_user_active'),
    ('platform_adjust_tenant_quota')
)
select
  procedure.proname as function_name,
  position(
    'array[''operator'', ''billing'']'
    in lower(pg_get_functiondef(procedure.oid))
  ) > 0 as operator_and_billing_enabled
from pg_proc procedure
join pg_namespace namespace on namespace.oid = procedure.pronamespace
join expected on expected.function_name = procedure.proname
where namespace.nspname = 'public'
order by procedure.proname;

-- 22. Contrato e proteções da sincronização Stripe versionada.
select
  procedure.oid::regprocedure::text as function_signature,
  position('stripe_webhook_events' in function_source) > 0
    as records_event_id,
  position('payload divergente' in function_source) > 0
    as rejects_payload_hash_collision,
  position('p_event_created_at < last_event_created_at' in function_source) > 0
    as rejects_older_event_order,
  position('customer.subscription.deleted' in function_source) > 0
    as preserves_deletion_downgrade,
  position('tenant_usage_periods' in function_source) > 0
    as updates_usage_period
from (
  select
    procedure.oid,
    lower(pg_get_functiondef(procedure.oid)) as function_source
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'prospecta_sync_stripe_subscription'
    and pg_get_function_identity_arguments(procedure.oid) =
      'p_event_id text, p_event_type text, '
      || 'p_event_created_at timestamp with time zone, '
      || 'p_payload_hash text, p_tenant_id uuid, p_customer_id text, '
      || 'p_subscription_id text, p_price_id text, p_product_id text, '
      || 'p_status text, p_period_start timestamp with time zone, '
      || 'p_period_end timestamp with time zone, '
      || 'p_cancel_at_period_end boolean'
) procedure;

-- 17. Ensure deve validar status/período e ser usado por geração/comando.
with function_source as (
  select
    procedure.proname,
    lower(pg_get_functiondef(procedure.oid)) as source
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname in (
      'prospecta_ensure_usage_period',
      'prospecta_insert_leads_with_quota',
      'prospecta_request_command'
    )
)
select
  proname,
  case proname
    when 'prospecta_ensure_usage_period' then
      position(
        'status not in (''active'', ''trialing'')' in source
      ) > 0
      and position('current_period_start' in source) > 0
      and position('current_period_end' in source) > 0
    when 'prospecta_insert_leads_with_quota' then
      position('prospecta_ensure_usage_period' in source) > 0
      and position('prospecta_ensure_usage_period' in source) <
        position('insert into public.leads' in source)
    when 'prospecta_request_command' then
      position('if p_command = ''rodando''' in source) > 0
      and position('if p_command = ''rodando''' in source) <
        position('prospecta_ensure_usage_period' in source)
    else false
  end as quota_gate_installed
from function_source
order by proname;

-- 18. Não deve restar ON CONFLICT inseguro na auditoria.
select
  procedure.oid::regprocedure::text as function_signature
from pg_proc procedure
join pg_namespace namespace on namespace.oid = procedure.pronamespace
where namespace.nspname = 'public'
  and lower(pg_get_functiondef(procedure.oid))
    like '%on conflict (request_id) do nothing%';

-- Resultado esperado da consulta 18: zero linhas.

-- 19. Trigger Stripe e consultas administrativas estritamente read-only.
select
  exists (
    select 1
    from pg_trigger trigger_row
    join pg_class class on class.oid = trigger_row.tgrelid
    join pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relname = 'tenant_subscriptions'
      and trigger_row.tgname =
        'tenant_subscriptions_revoke_manual_grants'
      and not trigger_row.tgisinternal
  ) as stripe_grant_conflict_trigger,
  (
    select procedure.provolatile = 's'
      and position(
        'platform_reconcile' in lower(pg_get_functiondef(procedure.oid))
      ) = 0
      and position(
        'for update' in lower(pg_get_functiondef(procedure.oid))
      ) = 0
      and position(
        'insert into' in lower(pg_get_functiondef(procedure.oid))
      ) = 0
      and position(
        'update public.' in lower(pg_get_functiondef(procedure.oid))
      ) = 0
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'prospecta_admin_get_metrics'
  ) as metrics_strictly_read_only,
  (
    select procedure.provolatile = 's'
      and position(
        'platform_reconcile' in lower(pg_get_functiondef(procedure.oid))
      ) = 0
      and position(
        'for update' in lower(pg_get_functiondef(procedure.oid))
      ) = 0
      and position(
        'insert into' in lower(pg_get_functiondef(procedure.oid))
      ) = 0
      and position(
        'update public.' in lower(pg_get_functiondef(procedure.oid))
      ) = 0
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'prospecta_admin_list_tenants'
      and pg_get_function_identity_arguments(procedure.oid) =
        'p_search text, p_plan_code text, p_tenant_status text, '
        || 'p_subscription_status text, p_page integer, '
        || 'p_page_size integer'
  ) as tenant_search_strictly_read_only;

-- 20. Sanidade da outbox.
select 'outbox_pending_with_completion' as check_name, count(*) as violations
from public.platform_external_operations
where status = 'pending' and completed_at is not null
union all
select 'outbox_success_with_error', count(*)
from public.platform_external_operations
where status = 'succeeded' and error is not null
union all
select 'outbox_failed_without_error', count(*)
from public.platform_external_operations
where status = 'failed' and btrim(coalesce(error, '')) = '';

-- 21. Matriz da outbox e consulta Auth pendente read-only.
select
  position(
    'p_action in (''auth.block'', ''auth.unblock'')'
    in lower(pg_get_functiondef(
      to_regprocedure(
        'public.prospecta_admin_begin_external_operation('
        || 'uuid,uuid,uuid,text,jsonb,text)'
      )
    ))
  ) > 0 as begin_accepts_auth_actions,
  position(
    'array[''operator'', ''billing'']'
    in lower(pg_get_functiondef(
      to_regprocedure(
        'public.prospecta_admin_begin_external_operation('
        || 'uuid,uuid,uuid,text,jsonb,text)'
      )
    ))
  ) > 0 as auth_accepts_operator_and_billing,
  position(
    'when p_action like ''billing.%'' then array[''billing'']'
    in lower(pg_get_functiondef(
      to_regprocedure(
        'public.prospecta_admin_begin_external_operation('
        || 'uuid,uuid,uuid,text,jsonb,text)'
      )
    ))
  ) > 0 as billing_actions_are_billing_only,
  (
    select procedure.provolatile = 's'
      and position('for update' in lower(pg_get_functiondef(procedure.oid))) = 0
      and position('insert into' in lower(pg_get_functiondef(procedure.oid))) = 0
      and position('update public.' in lower(pg_get_functiondef(procedure.oid))) = 0
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname =
        'prospecta_admin_list_pending_auth_operations'
  ) as pending_auth_query_read_only;

-- 16. Busca global, revogação e preflight de bloqueio esperados.
select
  procedure.proname as function_name,
  case procedure.proname
    when 'prospecta_admin_list_tenants' then
      position('owner.owner_email ilike' in function_source) > 0
      and position('tenant.stripe_customer_id ilike' in function_source) > 0
      and position(
        'subscription.stripe_subscription_id' in function_source
      ) > 0
    when 'prospecta_admin_revoke_billing_grant' then
      position(
        'platform_reconcile_manual_grant' in function_source
      ) > 0
    when 'prospecta_admin_set_user_active' then
      position('tenant_memberships' in function_source) > 0
      and position('platform_admins' in function_source) > 0
      and position('update public.profiles' in function_source) >
        position('tenant_memberships' in function_source)
    else false
  end as contract_installed
from (
  select
    procedure.proname,
    lower(pg_get_functiondef(procedure.oid)) as function_source
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname in (
      'prospecta_admin_list_tenants',
      'prospecta_admin_revoke_billing_grant',
      'prospecta_admin_set_user_active'
    )
    and (
      procedure.proname <> 'prospecta_admin_list_tenants'
      or pg_get_function_identity_arguments(procedure.oid) =
        'p_search text, p_plan_code text, p_tenant_status text, '
        || 'p_subscription_status text, p_page integer, '
        || 'p_page_size integer'
    )
) procedure
order by procedure.proname;
