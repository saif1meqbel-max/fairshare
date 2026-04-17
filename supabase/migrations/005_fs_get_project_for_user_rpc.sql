-- Reliable project read for invitees: RLS + fs_user_is_project_member can still fail when
-- auth.users.email, JWT, and profiles.email disagree. This RPC runs as definer, returns the row
-- only when the caller is the owner OR a members[] entry matches any of those emails.

CREATE OR REPLACE FUNCTION public.fs_get_project_for_user(project_id text)
RETURNS SETOF public.fs_projects
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.*
  FROM public.fs_projects p
  CROSS JOIN LATERAL (
    SELECT
      lower(trim(COALESCE((SELECT u.email::text FROM auth.users u WHERE u.id = auth.uid()), ''))) AS auth_email,
      lower(trim(COALESCE(auth.jwt() ->> 'email', ''))) AS jwt_email,
      lower(trim(COALESCE((SELECT pr.email FROM public.profiles pr WHERE pr.id = auth.uid()), ''))) AS profile_email
  ) AS em
  WHERE p.id = project_id
    AND auth.uid() IS NOT NULL
    AND (
      p.owner_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE jsonb_typeof(COALESCE(p.body -> 'members', 'null'::jsonb))
            WHEN 'array' THEN COALESCE(p.body -> 'members', '[]'::jsonb)
            ELSE '[]'::jsonb
          END
        ) AS m
        WHERE trim(COALESCE(m ->> 'email', '')) <> ''
          AND (
            (em.auth_email <> '' AND lower(trim(m ->> 'email')) = em.auth_email)
            OR (em.jwt_email <> '' AND lower(trim(m ->> 'email')) = em.jwt_email)
            OR (em.profile_email <> '' AND lower(trim(m ->> 'email')) = em.profile_email)
          )
      )
    );
$$;

REVOKE ALL ON FUNCTION public.fs_get_project_for_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fs_get_project_for_user(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.fs_get_project_for_user(text) IS
  'Returns fs_projects row if caller owns it or is listed in body.members by email (auth.users / JWT / profiles).';
