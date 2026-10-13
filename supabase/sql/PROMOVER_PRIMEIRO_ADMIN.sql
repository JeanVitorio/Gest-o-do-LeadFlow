-- Execute somente depois de EXECUTAR_NO_SQL_EDITOR.sql.
-- Troque o valor abaixo pelo e-mail de uma conta já criada no Supabase Auth.

do $$
declare
  v_email text := 'SUBSTITUA_PELO_SEU_EMAIL';
  v_user_id uuid;
  v_request_id uuid := gen_random_uuid();
begin
  if v_email = 'SUBSTITUA_PELO_SEU_EMAIL' then
    raise exception 'Informe o e-mail do primeiro administrador antes de executar';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('platform-admin-bootstrap', 0)
  );
  if exists (
    select 1
    from public.platform_admins
    where is_active
  ) then
    raise exception 'Já existe platform admin ativo; bootstrap recusado';
  end if;

  select id
    into v_user_id
  from auth.users
  where lower(email) = lower(btrim(v_email))
  limit 1;

  if v_user_id is null then
    raise exception 'Nenhuma conta encontrada no Supabase Auth para o e-mail informado';
  end if;

  insert into public.platform_admins (
    user_id,
    role,
    is_active
  )
  values (
    v_user_id,
    'billing',
    true
  )
  on conflict (user_id) do update
  set
    role = excluded.role,
    is_active = true;

  insert into public.platform_audit_log (
    actor_user_id,
    actor_role,
    action,
    target_type,
    target_id,
    request_id,
    reason,
    payload_after,
    metadata
  )
  values (
    v_user_id,
    'billing',
    'platform_admin.bootstrap',
    'platform_admin',
    v_user_id::text,
    v_request_id::text,
    'Bootstrap inicial do platform admin billing',
    jsonb_build_object(
      'user_id', v_user_id,
      'role', 'billing',
      'is_active', true
    ),
    jsonb_build_object('bootstrap', true)
  );
end;
$$;

select
  auth_user.email,
  platform_admin.role,
  platform_admin.is_active,
  platform_admin.updated_at
from public.platform_admins platform_admin
join auth.users auth_user
  on auth_user.id = platform_admin.user_id
order by platform_admin.updated_at desc;
