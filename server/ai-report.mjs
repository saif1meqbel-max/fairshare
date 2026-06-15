/**
 * POST /api/ai/report
 * Generates a full markdown contribution report via Claude.
 * Only callable by project owners (role === 'lead' or 'instructor').
 *
 * Body: { projectId, format: 'markdown' | 'pdf' }
 * Returns: { report: "<markdown string>", storedId: "<uuid>" }
 */

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { verifyJWT, buildProjectSnapshot, getAnthropic, ANTHROPIC_MODEL, logTokens, ok, fail } from './ai-utils.mjs';

const router = express.Router();

router.post('/api/ai/report', async (req, res) => {
  try {
    const { user, supabase } = await verifyJWT(req.headers.authorization);
    const { projectId, format = 'markdown' } = req.body || {};
    if (!projectId) return fail(res, 400, 'projectId is required.');

    const snap = await buildProjectSnapshot(projectId, supabase);

    // Verify the requesting user is the project lead
    const requesterMember = snap.members.find(m => m.email === user.email);
    const isOwner = requesterMember?.role === 'lead' || requesterMember?.role === 'instructor' || requesterMember?.role === 'owner';
    if (!isOwner) return fail(res, 403, 'Only project owners can generate AI reports.');

    const prompt = `You are FairShare AI Manager. Write a professional, comprehensive contribution report for the following project.

PROJECT DATA:
${JSON.stringify({
  project:    snap.project,
  members:    snap.members,
  tasks:      snap.tasks,
  activities: snap.activities,
  documents:  snap.documents,
}, null, 2)}

Write the report in Markdown format with these sections:

# FairShare Contribution Report — [Project Name]
*Generated: [today's date]*

## Executive Summary
(2–3 paragraphs: overall team performance, whether the project is on track, and the general distribution of work)

## Team Member Contributions

For each member, write a dedicated subsection:
### [Member Name]
- **Tasks completed:** X / Y assigned
- **Documents edited:** N
- **Activity level:** (High / Medium / Low / None)
- **Contribution assessment:** (2–3 sentences: what they did, how consistent, their impact)
- **Suggested focus:** (1 sentence on what they should prioritise next)

## Workload Fairness Assessment
(Is the workload equitably distributed? Use percentages and task counts. If imbalance is detected, say so plainly.)

## Recommended Redistributions
(If any member is overloaded or underutilised, suggest specific task reassignments by name)

## Summary & Next Steps
(Short bullet list of the 3 most important actions the team should take)

Rules:
- Base every statement strictly on the data. Do not invent tasks, edits, or activity.
- If a member has no activity, say so plainly.
- Use professional but direct language.
- Do not add any disclaimers about AI limitations.`;

    const anthropic = getAnthropic();
    const msg = await anthropic.messages.create({
      model:      ANTHROPIC_MODEL,
      max_tokens: 3000,
      messages:   [{ role: 'user', content: prompt }],
    });

    logTokens('/api/ai/report', msg.usage);

    const block  = msg.content?.find(b => b.type === 'text');
    const report = block?.text || '';

    if (!report) return fail(res, 500, 'AI returned an empty report.');

    // Persist to ai_reports using service role
    const serviceClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    const { data: stored, error: insertErr } = await serviceClient
      .from('ai_reports')
      .insert({ project_id: projectId, generated_by_email: user.email, content: report })
      .select('id')
      .single();

    if (insertErr) console.warn('[AI report] Could not persist:', insertErr.message);

    ok(res, { report, storedId: stored?.id || null });
  } catch (err) {
    console.error('[AI report]', err);
    fail(res, 500, err.message || 'Report generation failed.');
  }
});

export default router;
