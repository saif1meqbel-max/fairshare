-- Notify all other project members when someone adds a document (create or import).
-- Uses fs_get_project_for_user() so only users who can access the project can trigger sends.

CREATE OR REPLACE FUNCTION public.fs_notify_document_shared(
  p_project_id text,
  p_document_id text,
  p_document_title text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor uuid := auth.uid();
  proj RECORD;
  m record;
  em text;
  rid uuid;
  pname text;
  actor_label text;
  display_title text;
  nid text;
  n int := 0;
  rc int;
BEGIN
  IF actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not authenticated');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.fs_get_project_for_user(p_project_id) LIMIT 1) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT * INTO proj FROM public.fs_projects WHERE id = p_project_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'project not found');
  END IF;

  pname := COALESCE(NULLIF(trim(proj.body ->> 'name'), ''), 'Project');
  display_title := COALESCE(NULLIF(trim(p_document_title), ''), 'Document');
  IF length(display_title) > 120 THEN
    display_title := left(display_title, 117) || '...';
  END IF;

  SELECT COALESCE(
      NULLIF(trim(full_name), ''),
      NULLIF(split_part(email, '@', 1), '')
    )
  INTO actor_label
  FROM public.profiles
  WHERE id = actor;

  IF actor_label IS NULL OR btrim(actor_label) = '' THEN
    actor_label := 'Someone';
  END IF;

  FOR m IN
    SELECT value AS el
    FROM jsonb_array_elements(
      CASE jsonb_typeof(COALESCE(proj.body -> 'members', 'null'::jsonb))
        WHEN 'array' THEN COALESCE(proj.body -> 'members', '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    ) AS x(value)
  LOOP
    em := lower(trim(m.el ->> 'email'));
    CONTINUE WHEN em IS NULL OR em = '';

    SELECT p.id INTO rid FROM public.profiles p WHERE lower(trim(p.email)) = em LIMIT 1;
    CONTINUE WHEN rid IS NULL;
    CONTINUE WHEN rid = actor;

    nid := 'docshare-' || p_project_id || '-' || p_document_id || '-' || rid::text || '-' || floor(extract(epoch FROM now()) * 1000)::bigint;

    INSERT INTO public.fs_notifications (id, user_id, body)
    VALUES (
      nid,
      rid,
      jsonb_build_object(
        'title', actor_label || ' added “' || display_title || '” — open it to edit together in real time.',
        'type', 'doc_shared',
        'ts', (extract(epoch FROM now()) * 1000)::bigint,
        'read', false,
        'projectId', p_project_id,
        'projectName', pname,
        'documentId', p_document_id,
        'documentTitle', display_title,
        'actorId', actor::text
      )
    )
    ON CONFLICT (id) DO NOTHING;

    GET DIAGNOSTICS rc = ROW_COUNT;
    n := n + rc;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'notified', n);
END;
$$;

REVOKE ALL ON FUNCTION public.fs_notify_document_shared(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fs_notify_document_shared(text, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.fs_notify_document_shared(text, text, text) IS
  'Inserts doc_shared notifications for other members with accounts; caller must have project access.';
