-- FairShare AI foundation tables (artifacts, runs, feedback, policy)

create table if not exists public.fs_ai_runs (
  id text primary key,
  project_id text references public.fs_projects(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  feature text not null,
  provider text,
  model text,
  mode text,
  status text not null default 'ok',
  latency_ms integer,
  prompt_excerpt text,
  response_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.fs_ai_artifacts (
  id text primary key,
  project_id text references public.fs_projects(id) on delete cascade,
  task_id text,
  document_id text,
  user_id uuid references public.profiles(id) on delete set null,
  feature text not null,
  body jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.fs_ai_feedback (
  id text primary key,
  run_id text references public.fs_ai_runs(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  rating text not null check (rating in ('up','down')),
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.fs_ai_policies (
  id text primary key,
  org_id text,
  role_scope text not null default 'all',
  feature_flags jsonb not null default '{}'::jsonb,
  pii_redaction boolean not null default true,
  external_model_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.fs_ai_runs enable row level security;
alter table public.fs_ai_artifacts enable row level security;
alter table public.fs_ai_feedback enable row level security;
alter table public.fs_ai_policies enable row level security;

drop policy if exists "AI runs project members select" on public.fs_ai_runs;
create policy "AI runs project members select"
on public.fs_ai_runs for select
using (public.fs_user_is_project_member(project_id));

drop policy if exists "AI runs project members insert" on public.fs_ai_runs;
create policy "AI runs project members insert"
on public.fs_ai_runs for insert
with check (public.fs_user_is_project_member(project_id));

drop policy if exists "AI artifacts project members select" on public.fs_ai_artifacts;
create policy "AI artifacts project members select"
on public.fs_ai_artifacts for select
using (public.fs_user_is_project_member(project_id));

drop policy if exists "AI artifacts project members mutate" on public.fs_ai_artifacts;
create policy "AI artifacts project members mutate"
on public.fs_ai_artifacts for all
using (public.fs_user_is_project_member(project_id))
with check (public.fs_user_is_project_member(project_id));

drop policy if exists "AI feedback author mutate" on public.fs_ai_feedback;
create policy "AI feedback author mutate"
on public.fs_ai_feedback for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "AI policies read authed" on public.fs_ai_policies;
create policy "AI policies read authed"
on public.fs_ai_policies for select
using (auth.role() = 'authenticated');
