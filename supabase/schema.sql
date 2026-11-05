create table if not exists public.assets (
  id text primary key,
  kind text not null default 'original',
  status text not null default 'uploaded',
  platform text,
  local_path text,
  local_paths text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  published_at timestamptz,
  failed_at timestamptz,
  scheduled_at timestamptz,
  queued_at timestamptz,
  cleanup_started_at timestamptz,
  cleanup_previous_status text,
  data jsonb not null default '{}'::jsonb
);

create index if not exists assets_status_created_idx
  on public.assets (status, created_at desc);
create index if not exists assets_platform_status_queued_idx
  on public.assets (platform, status, queued_at);
create index if not exists assets_kind_status_processed_idx
  on public.assets (kind, status, processed_at);
create index if not exists assets_kind_status_published_idx
  on public.assets (kind, status, published_at);
create index if not exists assets_status_failed_idx
  on public.assets (status, failed_at);
create index if not exists assets_status_scheduled_idx
  on public.assets (status, scheduled_at);

create table if not exists public.oauth_states (
  state text primary key,
  provider text not null,
  expires_at timestamptz not null
);
create index if not exists oauth_states_expiry_idx
  on public.oauth_states (expires_at);

create table if not exists public.oauth_connections (
  id text primary key,
  platform text not null,
  account_id text not null,
  provider text not null,
  display_name text not null default '',
  data jsonb not null default '{}'::jsonb,
  unique (platform, account_id)
);

alter table public.assets enable row level security;
alter table public.oauth_states enable row level security;
alter table public.oauth_connections enable row level security;

revoke all on public.assets, public.oauth_states, public.oauth_connections
  from anon, authenticated;
grant all on public.assets, public.oauth_states, public.oauth_connections
  to service_role;

create or replace function public.autoreel_patch_asset(
  p_id text,
  p_expected_statuses text[],
  p_patch jsonb,
  p_columns jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed_id text;
begin
  update public.assets as a
  set
    data = a.data || coalesce(p_patch, '{}'::jsonb),
    kind = case when p_columns ? 'kind' then p_columns->>'kind' else a.kind end,
    status = case when p_columns ? 'status' then p_columns->>'status' else a.status end,
    platform = case when p_columns ? 'platform' then p_columns->>'platform' else a.platform end,
    local_path = case when p_columns ? 'local_path' then p_columns->>'local_path' else a.local_path end,
    local_paths = case
      when not (p_columns ? 'local_paths') then a.local_paths
      when p_columns->'local_paths' = 'null'::jsonb then null
      else array(select jsonb_array_elements_text(p_columns->'local_paths'))
    end,
    processed_at = case when p_columns ? 'processed_at' then (p_columns->>'processed_at')::timestamptz else a.processed_at end,
    published_at = case when p_columns ? 'published_at' then (p_columns->>'published_at')::timestamptz else a.published_at end,
    failed_at = case when p_columns ? 'failed_at' then (p_columns->>'failed_at')::timestamptz else a.failed_at end,
    scheduled_at = case when p_columns ? 'scheduled_at' then (p_columns->>'scheduled_at')::timestamptz else a.scheduled_at end,
    queued_at = case when p_columns ? 'queued_at' then (p_columns->>'queued_at')::timestamptz else a.queued_at end,
    cleanup_started_at = case when p_columns ? 'cleanup_started_at' then (p_columns->>'cleanup_started_at')::timestamptz else a.cleanup_started_at end,
    cleanup_previous_status = case when p_columns ? 'cleanup_previous_status' then p_columns->>'cleanup_previous_status' else a.cleanup_previous_status end,
    updated_at = now()
  where a.id = p_id
    and (p_expected_statuses is null or a.status = any(p_expected_statuses))
  returning a.id into changed_id;

  return changed_id is not null;
end;
$$;

create or replace function public.autoreel_mark_asset_published(
  p_id text,
  p_post jsonb,
  p_published_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed_id text;
  saved_post jsonb;
begin
  saved_post := p_post || jsonb_build_object('publishedAt', p_published_at);

  update public.assets as a
  set
    status = 'published',
    platform = coalesce(p_post->>'platform', a.platform),
    published_at = p_published_at,
    updated_at = now(),
    data = a.data || jsonb_build_object(
      'status', 'published',
      'platform', coalesce(p_post->>'platform', a.platform),
      'postId', p_post->'postId',
      'publishedAt', p_published_at,
      'publishedPost', saved_post,
      'posts', coalesce(a.data->'posts', '[]'::jsonb) || jsonb_build_array(saved_post),
      'publicationAttempt', coalesce((a.data->>'publicationAttempt')::integer, 0) + 1
    )
  where a.id = p_id
    and a.status in ('publishing', 'processed', 'queued', 'upload_failed')
  returning a.id into changed_id;

  return changed_id is not null;
end;
$$;

create or replace function public.autoreel_queue_expired_failures(
  p_cutoff timestamptz,
  p_queued_at timestamptz
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed_count integer;
begin
  update public.assets as a
  set
    status = 'recovery',
    updated_at = now(),
    data = a.data || jsonb_build_object(
      'status', 'recovery',
      'recoveryQueuedAt', p_queued_at
    )
  where a.status = 'upload_failed' and a.failed_at <= p_cutoff;

  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

create or replace function public.autoreel_release_stale_cleanup_claims(
  p_cutoff timestamptz
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed_count integer;
begin
  update public.assets as a
  set
    status = a.cleanup_previous_status,
    cleanup_previous_status = null,
    cleanup_started_at = null,
    updated_at = now(),
    data = a.data || jsonb_build_object(
      'status', a.cleanup_previous_status,
      'cleanupPreviousStatus', null,
      'cleanupStartedAt', null
    )
  where a.status = 'cleaning'
    and a.cleanup_started_at <= p_cutoff
    and a.cleanup_previous_status in ('processed', 'published');

  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

revoke all on function public.autoreel_patch_asset(text, text[], jsonb, jsonb) from public;
revoke all on function public.autoreel_mark_asset_published(text, jsonb, timestamptz) from public;
revoke all on function public.autoreel_queue_expired_failures(timestamptz, timestamptz) from public;
revoke all on function public.autoreel_release_stale_cleanup_claims(timestamptz) from public;
grant execute on function public.autoreel_patch_asset(text, text[], jsonb, jsonb) to service_role;
grant execute on function public.autoreel_mark_asset_published(text, jsonb, timestamptz) to service_role;
grant execute on function public.autoreel_queue_expired_failures(timestamptz, timestamptz) to service_role;
grant execute on function public.autoreel_release_stale_cleanup_claims(timestamptz) to service_role;
