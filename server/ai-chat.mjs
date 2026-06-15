/**
 * FairShare AI Manager — chat endpoint (streaming SSE, OpenAI tool-calling)
 * POST /api/ai/chat
 *
 * Body:  { messages: ChatMessage[], projectId?: string }
 * Auth:  Supabase JWT in Authorization: Bearer <token>
 *
 * SSE events:
 *   { type: "delta",     text: "..." }  — streamed text chunk
 *   { type: "tool_call", name: "..." }  — tool being executed (UI indicator)
 *   { type: "done" }                    — stream finished
 *   { type: "error",     message: "..." }
 *
 * If projectId is provided, the full buildProjectSnapshot() output is injected
 * into the system prompt so the AI has real project context.
 * Conversation history is passed per-request (persisted client-side per project).
 */

import express from 'express';
import { verifyJWT, buildProjectSnapshot, getOpenAI, OPENAI_MODEL, logTokens } from './ai-utils.mjs';

import { definition as defProjectOverview, execute as execProjectOverview } from './ai-tools/getProjectOverview.mjs';
import { definition as defTasks,           execute as execTasks           } from './ai-tools/getTasks.mjs';
import { definition as defContributions,   execute as execContributions   } from './ai-tools/getTeamContributions.mjs';
import { definition as defActivity,        execute as execActivity        } from './ai-tools/getActivityLog.mjs';
import { definition as defCreateTask,      execute as execCreateTask      } from './ai-tools/createTask.mjs';
import { definition as defAnnouncement,    execute as execAnnouncement    } from './ai-tools/draftAnnouncement.mjs';

const router = express.Router();
router.use(express.json({ limit: '64kb' }));

// ── Tool registry ─────────────────────────────────────────────────────────────
const TOOLS = [defProjectOverview, defTasks, defContributions, defActivity, defCreateTask, defAnnouncement];

const TOOL_EXECUTORS = {
  getProjectOverview:   execProjectOverview,
  getTasks:             execTasks,
  getTeamContributions: execContributions,
  getActivityLog:       execActivity,
  createTask:           execCreateTask,
  draftAnnouncement:    execAnnouncement,
};

// ── System prompt ─────────────────────────────────────────────────────────────
const BASE_SYSTEM = `You are FairShare AI Manager — an intelligent assistant embedded inside FairShare, a collaborative project management platform used by academic and professional teams.

You help project leads and members with:
- Understanding project status, progress, and deadlines
- Reviewing task assignments and workloads
- Analysing team contributions and performance
- Reviewing activity history
- Creating tasks
- Drafting team announcements

Rules you must always follow:
1. Never invent data. Use the available tools to retrieve real information before answering.
2. If a tool returns an error or no data, say so clearly and suggest what the user can check.
3. Be concise and professional. Use bullet points and short paragraphs.
4. When creating tasks or sending announcements, confirm the action clearly.
5. You only have access to data the authenticated user is authorised to see.
6. If the question does not need data retrieval, answer directly without calling tools.
7. Format numbers, percentages, and dates clearly.`;

// ── SSE helper ────────────────────────────────────────────────────────────────
function send(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, rawArgs, supabase, userId) {
  const executor = TOOL_EXECUTORS[name];
  if (!executor) return { error: `Unknown tool: ${name}` };
  let args;
  try { args = JSON.parse(rawArgs); } catch { return { error: 'Malformed tool arguments.' }; }
  try { return await executor(args, supabase, userId); }
  catch (e) { console.error(`[AI tool] ${name}:`, e); return { error: e.message || 'Tool failed.' }; }
}

// ── Main route ────────────────────────────────────────────────────────────────
router.post('/api/ai/chat', async (req, res) => {
  res.setHeader('Content-Type',    'text/event-stream');
  res.setHeader('Cache-Control',   'no-cache');
  res.setHeader('Connection',      'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const { user, supabase } = await verifyJWT(req.headers.authorization);
    const { messages = [], projectId } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      send(res, { type: 'error', message: 'No messages provided.' }); return res.end();
    }

    const safeMessages = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-20)
      .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));

    if (!safeMessages.length) {
      send(res, { type: 'error', message: 'No valid messages after sanitisation.' }); return res.end();
    }

    // Inject real project snapshot into system prompt when a project is open
    let contextNote = '\n\nNo project is currently open. Ask the user which project they mean if relevant.';
    if (projectId) {
      try {
        const snap = await buildProjectSnapshot(projectId, supabase);
        contextNote = `\n\n## Current project context (use this before calling tools)\n${JSON.stringify({
          project:    snap.project,
          members:    snap.members,
          taskSummary: snap.tasks,
          recentActivity: snap.activities.all.slice(0, 15),
        }, null, 2)}\n\nDefault project_id for all tool calls: ${projectId}`;
        send(res, { type: 'context', loaded: true });
      } catch (e) {
        contextNote = `\n\nProject ID in context: ${projectId} (snapshot unavailable — use tools to fetch data).`;
      }
    }

    const openai = getOpenAI();
    const conversationMessages = [
      { role: 'system', content: BASE_SYSTEM + contextNote },
      ...safeMessages,
    ];

    const MAX_ROUNDS = 5;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const completion = await openai.chat.completions.create({
        model:       OPENAI_MODEL,
        messages:    conversationMessages,
        tools:       TOOLS,
        tool_choice: 'auto',
        stream:      false,
        max_tokens:  1024,
        temperature: 0.3,
      });

      const choice  = completion.choices[0];
      const message = choice.message;

      if (choice.finish_reason === 'tool_calls' && message.tool_calls?.length) {
        conversationMessages.push(message);
        for (const tc of message.tool_calls) {
          send(res, { type: 'tool_call', name: tc.function.name });
          const result = await executeTool(tc.function.name, tc.function.arguments, supabase, user.id);
          conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
        continue;
      }

      logTokens('/api/ai/chat', completion.usage);

      const text  = message.content || '';
      const CHUNK = 40;
      for (let i = 0; i < text.length; i += CHUNK) {
        send(res, { type: 'delta', text: text.slice(i, i + CHUNK) });
      }
      send(res, { type: 'done' });
      return res.end();
    }

    send(res, { type: 'error', message: 'AI did not produce a final response after tool calls. Try again.' });
    res.end();

  } catch (err) {
    console.error('[AI chat]', err);
    send(res, { type: 'error', message: err.message || 'An unexpected error occurred.' });
    res.end();
  }
});

export default router;
