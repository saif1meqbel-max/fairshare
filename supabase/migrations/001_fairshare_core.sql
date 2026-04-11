-- FairShare core schema (Supabase: run in SQL editor or supabase db push)
-- Enable RLS + Realtime on chat after applying.

create extension if not exists "pgcrypto";

-- Profiles (1:1 with auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  full_name text,
  role text not null default 'student' check (role in ('student', 'instructor', 'admin')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce(nullif(new.raw_user_meta_data->>'role', ''), 'student')
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, profiles.full_name),
    role = coalesce(nullif(excluded.role, ''), profiles.role);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Project graph (body holds members[] and UI fields)
create table if not exists public.fs_projects (
  id text primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  body jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists fs_projects_owner_idx on public.fs_projects (owner_id);

create table if not exists public.fs_tasks (
  id text primary key,
  project_id text not null references public.fs_projects (id) on delete cascade,
  body jsonb not null default '{}'::jsonb
);

create index if not exists fs_tasks_project_idx on public.fs_tasks (project_id);

create table if not exists public.fs_documents (
  id text primary key,
  project_id text not null references public.fs_projects (id) on delete cascade,
  body jsonb not null default '{}'::jsonb
);

create index if not exists fs_documents_project_idx on public.fs_documents (project_id);

create table if not exists public.fs_activities (
  id text primary key,
  project_id text not null references public.fs_projects (id) on delete cascade,
  body jsonb not null default '{}'::jsonb,
  created_ms bigint
);

create index if not exists fs_activities_project_idx on public.fs_activities (project_id);

create table if not exists public.fs_chat_messages (
  id text primary key,
  project_id text not null references public.fs_projects (id) on delete cascade,
  channel text not null default 'general',
  body jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists fs_chat_project_channel_idx on public.fs_chat_messages (project_id, channel);

create table if not exists public.fs_notifications (
  id text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  body jsonb not null default '{}'::jsonb
);

create index if not exists fs_notifs_user_idx on public.fs_notifications (user_id);

create table if not exists public.fs_user_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  score_config jsonb not null default '{}'::jsonb
);

-- Institutional licensing (optional; Stripe webhooks can update this)
create table if not exists public.fs_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  stripe_customer_id text,
  stripe_subscription_id text,
  seat_limit int not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists public.fs_org_members (
  org_id uuid not null references public.fs_organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (org_id, user_id)
);

-- RLS
alter table public.profiles enable row level security;
alter table public.fs_projects enable row level security;
alter table public.fs_tasks enable row level security;
alter table public.fs_documents enable row level security;
alter table public.fs_activities enable row level security;
alter table public.fs_chat_messages enable row level security;
alter table public.fs_notifications enable row level security;
alter table public.fs_user_settings enable row level security;
alter table public.fs_organizations enable row level security;
alter table public.fs_org_members enable row level security;

create policy profiles_self on public.profiles
  for select using (id = auth.uid());
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid());

create policy profiles_admin_read on public.profiles
  for select using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'instructor'))
  );

-- Projects: owner or listed member by email
create policy fs_projects_select on public.fs_projects
  for select using (
    owner_id = auth.uid()
    or exists (
      select 1 from public.profiles pr
      where pr.id = auth.uid()
        and pr.email is not null
        and fs_projects.body->'members' @> jsonb_build_array(jsonb_build_object('email', pr.email))
    )
  );

create policy fs_projects_write on public.fs_projects
  for all using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy fs_tasks_all on public.fs_tasks
  for all using (
    exists (select 1 from public.fs_projects p where p.id = fs_tasks.project_id and (
      p.owner_id = auth.uid()
      or exists (
        select 1 from public.profiles pr
        where pr.id = auth.uid() and pr.email is not null
          and p.body->'members' @> jsonb_build_array(jsonb_build_object('email', pr.email))
      )
    ))
  )
  with check (
    exists (select 1 from public.fs_projects p where p.id = fs_tasks.project_id and (
      p.owner_id = auth.uid()
      or exists (
        select 1 from public.profiles pr
        where pr.id = auth.uid() and pr.email is not null
          and p.body->'members' @> jsonb_build_array(jsonb_build_object('email', pr.email))
      )
    ))
  );

create policy fs_documents_all on public.fs_documents
  for all using (
    exists (select 1 from public.fs_projects p where p.id = fs_documents.project_id and (
      p.owner_id = auth.uid()
      or exists (
        select 1 from public.profiles pr
        where pr.id = auth.uid() and pr.email is not null
          and p.body->'members' @> jsonb_build_array(jsonb_build_object('email', pr.email))
      )
    ))
  )
  with check (
    exists (select 1 from public.fs_projects p where p.id = fs_documents.project_id and (
      p.owner_id = auth.uid()
      or exists (
        select 1 from public.profiles pr
        where pr.id = auth.uid() and pr.email is not null
          and p.body->'members' @> jsonb_build_array(jsonb_build_object('email', pr.email))
      )
    ))
  );

create policy fs_activities_all on public.fs_activities
  for all using (
    exists (select 1 from public.fs_projects p where p.id = fs_activities.project_id and (
      p.owner_id = auth.uid()
      or exists (
        select 1 from public.profiles pr
        where pr.id = auth.uid() and pr.email is not null
          and p.body->'members' @> jsonb_build_array(jsonb_build_object('email', pr.email))
      )
    ))
  )
  with check (
    exists (select 1 from public.fs_projects p where p.id = fs_activities.project_id and (
      p.owner_id = auth.uid()
      or exists (
        select 1 from public.profiles pr
        where pr.id = auth.uid() and pr.email is not null
          and p.body->'members' @> jsonb_build_array(jsonb_build_object('email', pr.email))
      )
    ))
  );

create policy fs_chat_select on public.fs_chat_messages
  for select using (
    exists (select 1 from public.fs_projects p where p.id = fs_chat_messages.project_id and (
      p.owner_id = auth.uid()
      or exists (
        select 1 from public.profiles pr
        where pr.id = auth.uid() and pr.email is not null
          and p.body->'members' @> jsonb_build_array(jsonb_build_object('email', pr.email))
      )
    ))
  );

create policy fs_chat_insert on public.fs_chat_messages
  for insert with check (
    exists (select 1 from public.fs_projects p where p.id = fs_chat_messages.project_id and (
      p.owner_id = auth.uid()
      or exists (
        select 1 from public.profiles pr
        where pr.id = auth.uid() and pr.email is not null
          and p.body->'members' @> jsonb_build_array(jsonb_build_object('email', pr.email))
      )
    ))
  );

create policy fs_notifs_own on public.fs_notifications
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy fs_settings_own on public.fs_user_settings
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy fs_org_member_read on public.fs_organizations
  for select using (
    exists (select 1 from public.fs_org_members m where m.org_id = fs_organizations.id and m.user_id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create policy fs_org_members_read on public.fs_org_members
  for select using (user_id = auth.uid());

-- Realtime (Dashboard → Database → Replication)
alter publication supabase_realtime add table public.fs_chat_messages;
