/**
 * POST /api/ai/score
 * Multi-dimensional contribution scoring (0–100) per member via OpenAI JSON mode.
 * Stores results in ai_scores for historical trend tracking.
 *
 * Dimensions:
 *   taskCompletionRate  — tasks completed vs assigned
 *   qualityScore        — doc edits, revision count, recency
 *   collaborationScore  — cross-member activity, chat participation
 *   consistencyScore    — activity spread over time vs single burst
 *   velocityTrend       — speeding up or slowing down over last 7 days
 *
 * Returns: { members: [{ name, userId, contributionScore, breakdown, scoringReason }] }
 */

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { verifyJWT, buildProjectSnapshot, getOpenAI, OPENAI_MODEL, logTokens, ok, fail } from './ai-utils.mjs';

const router = express.Router();

router.post('/api/ai/score', async (req, res) => {
  try {
    const { user, supabase } = await verifyJWT(req.headers.authorization);
    const { projectId } = req.body || {};
    if (!projectId) return fail(res, 400, 'projectId is required.');

    const snap = await buildProjectSnapshot(projectId, supabase);

    const prompt = `You are a contribution scoring engine for FairShare. Score each team member 0–100 on five dimensions based strictly on the data provided.

PROJECT DATA:
${JSON.stringify({
  project:    snap.project,
  members:    snap.members,
  tasks:      snap.tasks,
  activities: snap.activities,
  documents:  snap.documents,
  recentChat: snap.recentChat,
}, null, 2)}

Scoring dimensions (each 0–100):
- taskCompletionRate: tasks marked done vs tasks assigned to this member
- qualityScore: doc edits, document creation, activity variety
- collaborationScore: cross-member interactions, chat messages sent, shared tasks
- consistencyScore: was activity spread over the week or all in one burst?
- velocityTrend: is activity increasing (positive) or decreasing (negative) recently? (-100 to +100, normalise to 0–100 where 50 = stable)

Weighted average → contributionScore:
  taskCompletionRate × 0.35
  qualityScore       × 0.20
  collaborationScore × 0.20
  consistencyScore   × 0.15
  velocityTrend      × 0.10

Return ONLY valid JSON (no markdown), exactly this shape:
{
  "members": [
    {
      "name": "exact member name from members list",
      "contributionScore": <integer 0–100>,
      "breakdown": {
        "taskCompletionRate": <0–100>,
        "qualityScore":       <0–100>,
        "collaborationScore": <0–100>,
        "consistencyScore":   <0–100>,
        "velocityTrend":      <0–100>
      },
      "scoringReason": "one sentence explaining the score, referencing real data"
    }
  ]
}

Rules:
- Include every member from the members list, even those with zero activity.
- Never invent facts. Use only the provided data.
- A member with no tasks and no activity should score around 0–15.`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model:           OPENAI_MODEL,
      messages:        [{ role: 'user', content: prompt }],
      temperature:     0.1,
      max_tokens:      1200,
      response_format: { type: 'json_object' },
    });

    logTokens('/api/ai/score', completion.usage);

    let scored;
    try { scored = JSON.parse(completion.choices[0].message.content); }
    catch { return fail(res, 500, 'AI returned malformed JSON.'); }

    // Persist scores to ai_scores table for historical trending
    // Use service role to bypass RLS for inserts
    const serviceClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    const scoredAt = new Date().toISOString();
    const inserts  = (scored.members || []).map(m => ({
      project_id: projectId,
      member_name: m.name,
      score:      m.contributionScore,
      breakdown:  m.breakdown,
      scored_at:  scoredAt,
    }));

    if (inserts.length) {
      const { error: insertErr } = await serviceClient.from('ai_scores').insert(inserts);
      if (insertErr) console.warn('[AI score] Could not persist scores:', insertErr.message);
    }

    ok(res, { members: scored.members || [], scoredAt });
  } catch (err) {
    console.error('[AI score]', err);
    fail(res, 500, err.message || 'Scoring failed.');
  }
});

export default router;
