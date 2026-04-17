-- Allow invitees to persist membership (id + inviteUserId on their members[] row) without being project owner.
-- Client-only "open" was a preview: RLS blocks non-owners from updating fs_projects.body.

CREATE OR REPLACE FUNCTION public.fs_join_project(p_project_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  proj RECORD;
  prof RECORD;
  auth_em text;
  jwt_em text;
  prof_em text;
  match_em text;
  elem jsonb;
  new_members jsonb := '[]'::jsonb;
  m_email text;
  found_invite boolean := false;
  already_joined boolean := false;
  full_name text;
  members_arr jsonb;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not authenticated');
  END IF;

  SELECT * INTO prof FROM public.profiles WHERE id = uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'profile not found');
  END IF;

  SELECT lower(trim(COALESCE(u.email::text, ''))) INTO auth_em FROM auth.users u WHERE u.id = uid;
  jwt_em := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
  prof_em := lower(trim(COALESCE(prof.email, '')));

  match_em := COALESCE(NULLIF(auth_em, ''), NULLIF(jwt_em, ''), NULLIF(prof_em, ''));
  IF match_em IS NULL OR match_em = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no email on account');
  END IF;

  SELECT * INTO proj FROM public.fs_projects WHERE id = p_project_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'project not found');
  END IF;

  full_name := COALESCE(
    NULLIF(trim(prof.full_name), ''),
    split_part(COALESCE(prof.email, match_em || '@local'), '@', 1)
  );

  members_arr := CASE jsonb_typeof(COALESCE(proj.body -> 'members', 'null'::jsonb))
    WHEN 'array' THEN COALESCE(proj.body -> 'members', '[]'::jsonb)
    ELSE '[]'::jsonb
  END;

  FOR elem IN SELECT jsonb_array_elements(members_arr)
  LOOP
    m_email := lower(trim(COALESCE(elem ->> 'email', '')));
    IF m_email <> '' AND m_email = match_em THEN
      found_invite := true;
      IF trim(COALESCE(elem ->> 'inviteUserId', '')) = uid::text
        OR trim(COALESCE(elem ->> 'id', '')) = uid::text
      THEN
        already_joined := true;
        new_members := new_members || jsonb_build_array(elem);
      ELSE
        new_members := new_members || jsonb_build_array(
          elem || jsonb_build_object(
            'id', uid::text,
            'inviteUserId', uid::text,
            'name', full_name,
            'email', COALESCE(prof.email, elem ->> 'email'),
            'role', COALESCE(elem ->> 'role', prof.role::text)
          )
        );
      END IF;
    ELSE
      new_members := new_members || jsonb_build_array(elem);
    END IF;
  END LOOP;

  IF NOT found_invite THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not invited');
  END IF;

  IF already_joined THEN
    RETURN jsonb_build_object('ok', true, 'alreadyJoined', true);
  END IF;

  UPDATE public.fs_projects
  SET
    body = jsonb_set(COALESCE(body, '{}'::jsonb), '{members}', new_members, true),
    updated_at = now()
  WHERE id = p_project_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.fs_join_project(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fs_join_project(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.fs_join_project(text) IS
  'Sets members[].id and inviteUserId for the caller''s email so they fully join the project (persists body).';
