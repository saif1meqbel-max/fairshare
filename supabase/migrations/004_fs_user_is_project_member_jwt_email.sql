-- Invitees could not open projects when profiles.email drifted from auth.users.email
-- (RLS used only profiles; notifications trigger also uses profiles — but JWT is the source of truth for “who is logged in”).
-- This version matches members[].email to BOTH auth.jwt() email and profiles.email, and safely handles non-array members JSON.

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
    WHERE trim(COALESCE(m ->> 'email', '')) <> ''
      AND (
        lower(trim(m ->> 'email')) = u.jwt_em
        OR lower(trim(m ->> 'email')) = u.profile_em
      )
  );
$$;

COMMENT ON FUNCTION public.fs_user_is_project_member(jsonb, uuid) IS
  'True if JWT email or profile email matches a members[].email (case-insensitive). members must be a JSON array of objects.';
