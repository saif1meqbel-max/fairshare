-- Case-insensitive membership for project RLS (JSON member email vs profiles.email).
-- Lets invited users load projects, tasks, chat, etc. when emails differ only by case.
-- Also allow project owners to INSERT fs_notifications for invitees (DB trigger + client backup).

CREATE OR REPLACE FUNCTION public.fs_user_is_project_member(project_body jsonb, uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(project_body->'members', '[]'::jsonb)) AS m
    INNER JOIN public.profiles pr ON pr.id = uid
    WHERE pr.email IS NOT NULL
      AND trim(COALESCE(m->>'email', '')) <> ''
      AND lower(trim(m->>'email')) = lower(trim(pr.email))
  );
$$;

GRANT EXECUTE ON FUNCTION public.fs_user_is_project_member(jsonb, uuid) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.fs_user_is_project_member(jsonb, uuid) IS
  'True if uid''s profile email matches a project members[] entry (case-insensitive).';

-- Projects
DROP POLICY IF EXISTS fs_projects_select ON public.fs_projects;
CREATE POLICY fs_projects_select ON public.fs_projects
  FOR SELECT USING (
    owner_id = auth.uid()
    OR public.fs_user_is_project_member(body, auth.uid())
  );

-- Tasks
DROP POLICY IF EXISTS fs_tasks_all ON public.fs_tasks;
CREATE POLICY fs_tasks_all ON public.fs_tasks
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.fs_projects p
      WHERE p.id = fs_tasks.project_id
        AND (p.owner_id = auth.uid() OR public.fs_user_is_project_member(p.body, auth.uid()))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.fs_projects p
      WHERE p.id = fs_tasks.project_id
        AND (p.owner_id = auth.uid() OR public.fs_user_is_project_member(p.body, auth.uid()))
    )
  );

-- Documents
DROP POLICY IF EXISTS fs_documents_all ON public.fs_documents;
CREATE POLICY fs_documents_all ON public.fs_documents
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.fs_projects p
      WHERE p.id = fs_documents.project_id
        AND (p.owner_id = auth.uid() OR public.fs_user_is_project_member(p.body, auth.uid()))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.fs_projects p
      WHERE p.id = fs_documents.project_id
        AND (p.owner_id = auth.uid() OR public.fs_user_is_project_member(p.body, auth.uid()))
    )
  );

-- Activities
DROP POLICY IF EXISTS fs_activities_all ON public.fs_activities;
CREATE POLICY fs_activities_all ON public.fs_activities
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.fs_projects p
      WHERE p.id = fs_activities.project_id
        AND (p.owner_id = auth.uid() OR public.fs_user_is_project_member(p.body, auth.uid()))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.fs_projects p
      WHERE p.id = fs_activities.project_id
        AND (p.owner_id = auth.uid() OR public.fs_user_is_project_member(p.body, auth.uid()))
    )
  );

-- Chat
DROP POLICY IF EXISTS fs_chat_select ON public.fs_chat_messages;
CREATE POLICY fs_chat_select ON public.fs_chat_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.fs_projects p
      WHERE p.id = fs_chat_messages.project_id
        AND (p.owner_id = auth.uid() OR public.fs_user_is_project_member(p.body, auth.uid()))
    )
  );

DROP POLICY IF EXISTS fs_chat_insert ON public.fs_chat_messages;
CREATE POLICY fs_chat_insert ON public.fs_chat_messages
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.fs_projects p
      WHERE p.id = fs_chat_messages.project_id
        AND (p.owner_id = auth.uid() OR public.fs_user_is_project_member(p.body, auth.uid()))
    )
  );

-- In-app invites: owner may insert notification rows for another user who is listed as a member
CREATE POLICY fs_notifs_invite_insert_by_owner ON public.fs_notifications
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id IS NOT NULL
    AND user_id <> auth.uid()
    AND (body->>'projectId') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.fs_projects fp
      CROSS JOIN jsonb_array_elements(COALESCE(fp.body->'members', '[]'::jsonb)) AS mem
      INNER JOIN public.profiles pr ON pr.id = user_id
      WHERE fp.id = (body->>'projectId')
        AND fp.owner_id = auth.uid()
        AND trim(COALESCE(mem->>'email', '')) <> ''
        AND lower(trim(mem->>'email')) = lower(trim(pr.email))
    )
  );

-- Richer notification payload + keep trigger idempotent
CREATE OR REPLACE FUNCTION public.fs_notify_on_project_members_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_emails text[] := ARRAY[]::text[];
  new_emails text[] := ARRAY[]::text[];
  em text;
  pname text;
  rid uuid;
  nid text;
BEGIN
  pname := COALESCE(NULLIF(trim(NEW.body->>'name'), ''), 'a project');

  SELECT coalesce(
    array_agg(DISTINCT lower(trim(m->>'email'))) FILTER (WHERE m->>'email' IS NOT NULL AND trim(m->>'email') <> ''),
    ARRAY[]::text[]
  )
  INTO new_emails
  FROM jsonb_array_elements(COALESCE(NEW.body->'members', '[]'::jsonb)) AS m;

  IF TG_OP = 'UPDATE' AND OLD.body IS NOT NULL THEN
    SELECT coalesce(
      array_agg(DISTINCT lower(trim(m->>'email'))) FILTER (WHERE m->>'email' IS NOT NULL AND trim(m->>'email') <> ''),
      ARRAY[]::text[]
    )
    INTO old_emails
    FROM jsonb_array_elements(COALESCE(OLD.body->'members', '[]'::jsonb)) AS m;
  END IF;

  FOREACH em IN ARRAY new_emails
  LOOP
    IF em IS NULL OR em = '' THEN
      CONTINUE;
    END IF;
    IF old_emails IS NOT NULL AND em = ANY (old_emails) THEN
      CONTINUE;
    END IF;

    SELECT p.id INTO rid
    FROM public.profiles p
    WHERE lower(trim(p.email)) = em
    LIMIT 1;

    CONTINUE WHEN rid IS NULL;
    CONTINUE WHEN rid = NEW.owner_id;

    nid := 'invite-' || NEW.id || '-' || rid::text;

    INSERT INTO public.fs_notifications (id, user_id, body)
    VALUES (
      nid,
      rid,
      jsonb_build_object(
        'title', 'You''ve been added to ' || pname,
        'type', 'project_invite',
        'ts', (extract(epoch from now()) * 1000)::bigint,
        'read', false,
        'projectId', NEW.id,
        'projectName', pname
      )
    )
    ON CONFLICT (id) DO UPDATE SET
      body = excluded.body;
  END LOOP;

  RETURN NEW;
END;
$$;
