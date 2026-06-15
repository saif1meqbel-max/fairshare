/**
 * POST /api/ai/predict
 * Deadline intelligence via Claude (reasoning-heavy).
 * Uses current task velocity per member to predict:
 *   - Whether the project will hit its deadline
 *   - Which tasks are at risk
 *   - Who is the current bottleneck
 *   - A concrete recommendation
 */

import express from 'express';
import { verifyJWT, buildProjectSnapshot, getAnthropic, ANTHROPIC_MODEL, logTokens, ok, fail } from './ai-utils.mjs';

const router = express.Router();

router.post('/api/ai/predict', async (req, res) => {
  try {
    const { user, supabase } = await verifyJWT(req.headers.authorization);
    const { projectId } = req.body || {};
    if (!projectId) return fail(res, 400, 'projectId is required.');

    const snap = await buildProjectSnapshot(projectId, supabase);
    const now  = new Date();
    const deadline = snap.project.deadline ? new Date(snap.project.deadline) : null;
    const daysRemaining = deadline ? Math.ceil((deadline - now) / (1000 * 60 * 60 * 24)) : null;

    const prompt = `You are FairShare AI Manager performing deadline intelligence analysis.

PROJECT DATA:
${JSON.stringify({
  project:        snap.project,
  members:        snap.members,
  tasks:          snap.tasks,
  activities:     snap.activities,
  daysRemaining,
  snapshotAt:     new Date(snap.snapshotAt).toISOString(),
}, null, 2)}

Reason carefully about:
1. Current completion rate and how long it will take to finish remaining tasks at this pace
2. Which specific tasks are at risk of not being completed by the deadline
3. Which member's unfinished tasks are blocking the most progress (bottleneck)
4. A specific, actionable recommendation the team should take right now

Return ONLY valid JSON (no markdown), exactly this shape:
{
  "deadlineRisk": "low | medium | high | none",
  "deadlineRiskReason": "one sentence explaining why",
  "bottleneckMember": "name of the member or null if none",
  "bottleneckDetail": "one sentence about what they need to do",
  "atRiskTasks": ["task title 1", "task title 2"],
  "recommendation": "2-3 sentence concrete, specific recommendation",
  "projectedCompletionDate": "ISO date string or null if cannot estimate",
  "generatedAt": "${now.toISOString()}"
}

Rules:
- If there is no deadline, set deadlineRisk to "none".
- At risk tasks must come from the actual task list above.
- Be direct. Avoid generic advice like "communicate more" — reference specific tasks and members.`;

    const anthropic = getAnthropic();
    const msg = await anthropic.messages.create({
      model:      ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });

    logTokens('/api/ai/predict', msg.usage);

    const raw = msg.content?.find(b => b.type === 'text')?.text || '';
    let prediction;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      prediction  = JSON.parse(match ? match[0] : raw);
    } catch {
      return fail(res, 500, 'AI returned malformed JSON.');
    }

    ok(res, { prediction });
  } catch (err) {
    console.error('[AI predict]', err);
    fail(res, 500, err.message || 'Prediction failed.');
  }
});

export default router;
