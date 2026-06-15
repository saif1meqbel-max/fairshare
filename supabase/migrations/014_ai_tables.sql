-- ─────────────────────────────────────────────────────────────────────────────
-- FairShare AI Tables Migration
-- Run in: Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. ai_scores ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_scores (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   TEXT NOT NULL,
  member_name  TEXT NOT NULL,
  score        INTEGER CHECK (score BETWEEN 0 AND 100),
  breakdown    JSONB,
  scored_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_scores_project_id_idx ON public.ai_scores (project_id, scored_at DESC);
CREATE INDEX IF NOT EXISTS ai_scores_member_idx     ON public.ai_scores (project_id, member_name, scored_at DESC);

ALTER TABLE public.ai_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_scores_select" ON public.ai_scores
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.fs_projects p
      WHERE p.id::text = project_id
        AND (p.body ->> 'members')::jsonb @> jsonb_build_array(
              jsonb_build_object('email', auth.jwt() ->> 'email')
            )
    )
  );

CREATE POLICY "ai_scores_insert_service" ON public.ai_scores
  FOR INSERT WITH CHECK (auth.role() = 'service_role');


-- ── 2. ai_anomalies ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_anomalies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   TEXT NOT NULL,
  member_name  TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('sudden_drop', 'last_minute_spike', 'task_siphoning')),
  description  TEXT,
  severity     TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  detected_at  TIMESTAMPTZ DEFAULT NOW(),
  resolved     BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS ai_anomalies_project_idx ON public.ai_anomalies (project_id, detected_at DESC);

ALTER TABLE public.ai_anomalies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_anomalies_select" ON public.ai_anomalies
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.fs_projects p
      WHERE p.id::text = project_id
        AND (p.body ->> 'members')::jsonb @> jsonb_build_array(
              jsonb_build_object('email', auth.jwt() ->> 'email')
            )
    )
  );

CREATE POLICY "ai_anomalies_insert_service" ON public.ai_anomalies
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "ai_anomalies_update_lead" ON public.ai_anomalies
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.fs_projects p
      WHERE p.id::text = project_id
        AND (p.body ->> 'leadEmail') = (auth.jwt() ->> 'email')
    )
  );


-- ── 3. ai_reports ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_reports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          TEXT NOT NULL,
  generated_by_email  TEXT,
  content             TEXT NOT NULL,
  generated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_reports_project_idx ON public.ai_reports (project_id, generated_at DESC);

ALTER TABLE public.ai_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_reports_select" ON public.ai_reports
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.fs_projects p
      WHERE p.id::text = project_id
        AND (p.body ->> 'members')::jsonb @> jsonb_build_array(
              jsonb_build_object('email', auth.jwt() ->> 'email')
            )
    )
  );

CREATE POLICY "ai_reports_insert_service" ON public.ai_reports
  FOR INSERT WITH CHECK (auth.role() = 'service_role');
