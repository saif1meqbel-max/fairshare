-- RLS for fs_projects used fs_user_is_project_member() with JWT + profiles.email only.
-- When JWT omits `email` or profiles.email drifts from auth.users, SELECT returned no rows
-- for invitees — refresh dropped shared projects unless the notification-merge path ran.
-- Align RLS with fs_get_project_for_user (migration 005) by also matching auth.users.email.

CREATE OR REPLACE FUNCTION public.fs_member_email_matches_auth_user(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() IS NOT NULL
    AND trim(COALESCE(p_email, '')) <> ''
    AND EXISTS (
      SELECT 1
      FROM auth.users u
      WHERE u.id = auth.uid()
        AND lower(trim(COALESCE(u.email::text, ''))) = lower(trim(p_email))
    );
$$;

REVOKE ALL ON FUNCTION public.fs_member_email_matches_auth_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fs_member_email_matches_auth_user(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.fs_member_email_matches_auth_user(text) IS
  'True if p_email matches auth.users.email for the current session (case-insensitive).';

CREATE OR REPLACE FUNCTION public.fs_user_is_project_member(project_body jsonb, uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH u AS (
    SELECT
      lower(trim(COALESCE((SELECT p.email FROM public.profiles p WHERE p.id = uid), ''))) AS profile_em,
      lower(trim(COALESCE(auth.jwt() ->> 'email', ''))) AS jwt_em
  ),
  elems AS (
    SELECT m
    FROM u,
    LATERAL jsonb_array_elements(
      CASE jsonb_typeof(COALESCE(project_body -> 'members', 'null'::jsonb))
        WHEN 'array' THEN COALESCE(project_body -> 'members', '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    ) AS m
  )
  SELECT EXISTS (
    SELECT 1
    FROM elems, u
    WHERE uid = auth.uid()
      AND trim(COALESCE(m ->> 'email', '')) <> ''
      AND (
        lower(trim(m ->> 'email')) = u.jwt_em
        OR lower(trim(m ->> 'email')) = u.profile_em
        OR public.fs_member_email_matches_auth_user(m ->> 'email')
      )
  );
$$;

COMMENT ON FUNCTION public.fs_user_is_project_member(jsonb, uuid) IS
  'True if members[].email matches JWT, profiles.email, or auth.users.email (case-insensitive). uid must equal auth.uid().';
