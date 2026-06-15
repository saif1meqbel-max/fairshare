/**
 * POST /api/ai/assess
 * Team insight + per-member flags via OpenAI JSON mode.
 * Called automatically every 5 min while a project is open.
 */

import express from 'express';
import { verifyJWT, buildProjectSnapshot, getOpenAI, OPENAI_MODEL, logTokens, ok, fail } from './ai-utils.mjs';

const router = express.Router();

router.post('/api/ai/assess', async (req, res) => {
  try {
    const { user, supabase } = await verifyJWT(req.headers.authorization);
    const { projectId } = req.body || {};
    if (!projectId) return fail(res, 400, 'projectId is required.');

    const snap = await buildProjectSnapshot(projectId, supabase);

    const prompt = `You are FairShare AI Manager. Analyse the project telemetry and produce a JSON assessment.

PROJECT DATA:
${JSON.stringify(snap, null, 2)}

Return ONLY valid JSON (no markdown) in this exact shape:
{
  "teamInsight": "1-2 sentence overall team assessment",
  "alert": "string or null — urgent issue if any (overdue tasks, inactive members)",
  "members": [
    {
      "name": "member name matching the members list exactly",
      "insight": "1 concise sentence about their specific contribution",
      "flag": "high | medium | low | none"
    }
  ],
  "generatedAt": ${Date.now()}
}

Rules:
- Only include members from the members array above.
- Base everything strictly on the data. Never invent facts.
- Be direct and specific. Reference real task titles or activity types.
- Keep each insight under 15 words.`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model:           OPENAI_MODEL,
      messages:        [{ role: 'user', content: prompt }],
      temperature:     0.2,
      max_tokens:      900,
      response_format: { type: 'json_object' },
    });

    logTokens('/api/ai/assess', completion.usage);

    let assessment;
    try { assessment = JSON.parse(completion.choices[0].message.content); }
    catch { return fail(res, 500, 'AI returned malformed JSON.'); }

    ok(res, { assessment });
  } catch (err) {
    console.error('[AI assess]', err);
    fail(res, 500, err.message || 'Assessment failed.');
  }
});

export default router;
