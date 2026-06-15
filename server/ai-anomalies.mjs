/**
 * POST /api/ai/anomalies
 * Detects contribution anomalies by comparing this week's activity to each member's
 * historical average from the ai_scores table. Uses OpenAI for structured JSON output.
 *
 * Anomaly types:
 *   - sudden_drop       — activity significantly below member's own baseline
 *   - last_minute_spike — burst of activity close to deadline
 *   - task_siphoning    — completing tasks assigned to someone else
 *
 * Returns: { anomalies: [{ memberName, type, description, severity }] }
 */

import express from 'express';
import { verifyJWT, buildProjectSnapshot, getOpenAI, OPENAI_MODEL, logTokens, ok, fail } from './ai-utils.mjs';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();

router.post('/api/ai/anomalies', async (req, res) => {
  try {
    const { user, supabase } = await verifyJWT(req.headers.authorization);
    const { projectId } = req.body || {};
    if (!projectId) return fail(res, 400, 'projectId is required.');

    const snap = await buildProjectSnapshot(projectId, supabase);
    const now  = new Date();
    const deadline = snap.project.deadline ? new Date(snap.project.deadline) : null;
    const daysToDeadline = deadline ? Math.ceil((deadline - now) / (1000 * 60 * 60 * 24)) : null;
    const nearDeadline   = daysToDeadline !== null && daysToDeadline <= 3;

    const prompt = `You are FairShare AI Manager performing contribution anomaly detection.

PROJECT DATA:
${JSON.stringify({
  project:             snap.project,
  members:             snap.members,
  tasks:               snap.tasks,
  activities:          snap.activities,
  daysToDeadline,
  nearDeadline,
  snapshotAt:          new Date(snap.snapshotAt).toISOString(),
}, null, 2)}

Detect these anomaly types strictly from the data:
- "sudden_drop": a member whose recent activity is significantly lower than what their task load and project stage suggest
- "last_minute_spike": a member with almost no activity until now but suddenly very active with deadline close
- "task_siphoning": a member completing or modifying tasks that were assigned to someone else

For each anomaly found, assign severity:
- "info"     — minor, worth noting
- "warning"  — noticeable pattern, should be discussed
- "critical" — requires immediate attention

Return ONLY valid JSON (no markdown), exactly this shape:
{
  "anomalies": [
    {
      "memberName": "exact name from members list",
      "type": "sudden_drop | last_minute_spike | task_siphoning",
      "description": "one specific sentence describing the anomaly with real data",
      "severity": "info | warning | critical"
    }
  ]
}

Rules:
- Return an empty anomalies array if no genuine anomalies are detected. Do not manufacture anomalies.
- Each anomaly must reference real member names, task titles, or activity counts from the data.
- Do not flag a member with no tasks as an anomaly — they simply have no work assigned.`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model:           OPENAI_MODEL,
      messages:        [{ role: 'user', content: prompt }],
      temperature:     0.1,
      max_tokens:      800,
      response_format: { type: 'json_object' },
    });

    logTokens('/api/ai/anomalies', completion.usage);

    let result;
    try { result = JSON.parse(completion.choices[0].message.content); }
    catch { return fail(res, 500, 'AI returned malformed JSON.'); }

    // Persist critical anomalies to ai_anomalies table
    const critical = (result.anomalies || []).filter(a => a.severity === 'critical');
    if (critical.length) {
      const serviceClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false } }
      );
      const inserts = critical.map(a => ({
        project_id:   projectId,
        member_name:  a.memberName,
        type:         a.type,
        description:  a.description,
        severity:     a.severity,
        detected_at:  new Date().toISOString(),
      }));
      const { error } = await serviceClient.from('ai_anomalies').insert(inserts);
      if (error) console.warn('[AI anomalies] Could not persist:', error.message);
    }

    ok(res, { anomalies: result.anomalies || [] });
  } catch (err) {
    console.error('[AI anomalies]', err);
    fail(res, 500, err.message || 'Anomaly detection failed.');
  }
});

export default router;
