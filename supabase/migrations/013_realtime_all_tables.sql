-- FairShare — Enable full real-time sync on all project-scoped tables
-- Run this in the Supabase SQL editor (Dashboard → SQL editor → New query → Run)
-- Without REPLICA IDENTITY FULL, Supabase Realtime cannot deliver the full row
-- data for UPDATE and DELETE events to non-owner subscribers (RLS is evaluated
-- against an empty row and the event is silently dropped).

-- ── 1. REPLICA IDENTITY FULL ─────────────────────────────────────────────────
ALTER TABLE public.fs_tasks         REPLICA IDENTITY FULL;
ALTER TABLE public.fs_projects      REPLICA IDENTITY FULL;
ALTER TABLE public.fs_activities    REPLICA IDENTITY FULL;
ALTER TABLE public.fs_documents     REPLICA IDENTITY FULL;
ALTER TABLE public.fs_notifications REPLICA IDENTITY FULL;
-- fs_chat_messages already set in migration 011

-- ── 2. Add all tables to the supabase_realtime publication (idempotent) ──────
DO $$
DECLARE
  tbl text;
  pub text := 'supabase_realtime';
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'fs_tasks', 'fs_projects', 'fs_activities',
    'fs_documents', 'fs_notifications', 'fs_chat_messages'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = pub AND tablename = tbl
    ) THEN
      EXECUTE format('ALTER PUBLICATION %I ADD TABLE public.%I', pub, tbl);
    END IF;
  END LOOP;
END $$;

-- ── 3. RLS SELECT policies — use auth.jwt() ->> 'email' instead of joining
--       profiles so we never trigger a recursive policy evaluation.
-- ─────────────────────────────────────────────────────────────────────────────

-- Tasks
DROP POLICY IF EXISTS fs_tasks_select_member ON public.fs_tasks;
CREATE POLICY fs_tasks_select_member ON public.fs_tasks
  FOR SELECT USING (
    auth.uid() IS NOT NULL AND (
      -- project owner
      EXISTS (
        SELECT 1 FROM public.fs_projects p
        WHERE p.id = fs_tasks.project_id
          AND p.owner_id = auth.uid()
      )
      OR
      -- project member (match by the email stored in the JWT — no profiles join)
      EXISTS (
        SELECT 1 FROM public.fs_projects p
        WHERE p.id = fs_tasks.project_id
          AND p.body->'members' @> jsonb_build_array(
                jsonb_build_object('email', auth.jwt() ->> 'email')
              )
      )
    )
  );

-- Documents
DROP POLICY IF EXISTS fs_documents_select_member ON public.fs_documents;
CREATE POLICY fs_documents_select_member ON public.fs_documents
  FOR SELECT USING (
    auth.uid() IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM public.fs_projects p
        WHERE p.id = fs_documents.project_id
          AND p.owner_id = auth.uid()
      )
      OR
      EXISTS (
        SELECT 1 FROM public.fs_projects p
        WHERE p.id = fs_documents.project_id
          AND p.body->'members' @> jsonb_build_array(
                jsonb_build_object('email', auth.jwt() ->> 'email')
              )
      )
    )
  );

-- Activities
DROP POLICY IF EXISTS fs_activities_select_member ON public.fs_activities;
CREATE POLICY fs_activities_select_member ON public.fs_activities
  FOR SELECT USING (
    auth.uid() IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM public.fs_projects p
        WHERE p.id = fs_activities.project_id
          AND p.owner_id = auth.uid()
      )
      OR
      EXISTS (
        SELECT 1 FROM public.fs_projects p
        WHERE p.id = fs_activities.project_id
          AND p.body->'members' @> jsonb_build_array(
                jsonb_build_object('email', auth.jwt() ->> 'email')
              )
      )
    )
  );

-- Projects (so members receive realtime row updates on the project itself)
DROP POLICY IF EXISTS fs_projects_select_member ON public.fs_projects;
CREATE POLICY fs_projects_select_member ON public.fs_projects
  FOR SELECT USING (
    auth.uid() IS NOT NULL AND (
      owner_id = auth.uid()
      OR
      body->'members' @> jsonb_build_array(
        jsonb_build_object('email', auth.jwt() ->> 'email')
      )
    )
  );
