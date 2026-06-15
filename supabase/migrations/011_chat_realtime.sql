-- Fix real-time chat delivery
-- Run this in the Supabase SQL editor (Dashboard → SQL editor → New query → Run)

-- 1. REPLICA IDENTITY FULL lets Supabase realtime include the full row in all
--    change events (INSERT / UPDATE / DELETE). Required for postgres_changes to
--    reliably deliver to non-owner project members.
ALTER TABLE public.fs_chat_messages REPLICA IDENTITY FULL;

-- 2. Make sure the table is in the realtime publication (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND tablename = 'fs_chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.fs_chat_messages;
  END IF;
END $$;

-- 3. Drop and recreate the SELECT policy using the more permissive helper so
--    the realtime system can evaluate it correctly for every connected user.
DROP POLICY IF EXISTS fs_chat_select ON public.fs_chat_messages;
CREATE POLICY fs_chat_select ON public.fs_chat_messages
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND (
      -- project owner
      EXISTS (
        SELECT 1 FROM public.fs_projects p
        WHERE p.id = fs_chat_messages.project_id
          AND p.owner_id = auth.uid()
      )
      OR
      -- project member (email stored in the JSONB members array)
      EXISTS (
        SELECT 1 FROM public.fs_projects p
        JOIN public.profiles pr ON pr.id = auth.uid()
        WHERE p.id = fs_chat_messages.project_id
          AND pr.email IS NOT NULL
          AND p.body->'members' @> jsonb_build_array(jsonb_build_object('email', pr.email))
      )
    )
  );

-- 4. Also ensure INSERT is consistent.
DROP POLICY IF EXISTS fs_chat_insert ON public.fs_chat_messages;
CREATE POLICY fs_chat_insert ON public.fs_chat_messages
  FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM public.fs_projects p
        WHERE p.id = fs_chat_messages.project_id
          AND p.owner_id = auth.uid()
      )
      OR
      EXISTS (
        SELECT 1 FROM public.fs_projects p
        JOIN public.profiles pr ON pr.id = auth.uid()
        WHERE p.id = fs_chat_messages.project_id
          AND pr.email IS NOT NULL
          AND p.body->'members' @> jsonb_build_array(jsonb_build_object('email', pr.email))
      )
    )
  );
