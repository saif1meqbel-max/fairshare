-- Notify registered users when their email is added to a project's members[].
-- Client-side code cannot insert rows for other users (RLS); this trigger runs as a definer.

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
        'projectId', NEW.id
      )
    )
    ON CONFLICT (id) DO UPDATE SET
      body = excluded.body;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fs_projects_notify_invites ON public.fs_projects;
CREATE TRIGGER trg_fs_projects_notify_invites
  AFTER INSERT OR UPDATE OF body ON public.fs_projects
  FOR EACH ROW
  EXECUTE FUNCTION public.fs_notify_on_project_members_change();

-- Live updates in the app when a notification row is inserted
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.fs_notifications;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
