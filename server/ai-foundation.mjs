import fs from 'fs/promises';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { FAIRSHARE_SUPPORT_KNOWLEDGE, SUPPORT_CHAT_BEHAVIOR } from './fairshare-knowledge.mjs';

const AI_AUDIT_FILE = path.join(process.cwd(), '.ai-audit.log');

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const DEFAULT_FLAGS = {
  globalEnabled: process.env.FS_AI_ENABLED !== '0',
  piiRedaction: process.env.FS_AI_PII_REDACT !== '0',
  contributionIntelligence: process.env.FS_AI_CONTRIBUTION !== '0',
  groupHealth: process.env.FS_AI_GROUP_HEALTH !== '0',
  instructorAssistant: process.env.FS_AI_INSTRUCTOR !== '0',
  studentCoach: process.env.FS_AI_STUDENT_COACH !== '0',
  fairnessExplainability: process.env.FS_AI_FAIRNESS !== '0',
  moderationPack: process.env.FS_AI_MODERATION !== '0',
  authenticitySignals: process.env.FS_AI_AUTHENTICITY !== '0',
  plannerCopilot: process.env.FS_AI_PLANNER !== '0',
  communicationIntel: process.env.FS_AI_COMMUNICATION !== '0',
  teamMatching: process.env.FS_AI_TEAM_MATCHING !== '0',
  institutionalCopilot: process.env.FS_AI_INSTITUTIONAL !== '0',
  lmsExport: process.env.FS_AI_LMS !== '0',
  complianceGuardrails: process.env.FS_AI_COMPLIANCE !== '0',
  parentModeReporting: process.env.FS_AI_PARENT_MODE !== '0',
  benchmarkNetwork: process.env.FS_AI_BENCHMARK !== '0',
  supportChat: process.env.FS_AI_SUPPORT_CHAT !== '0',
};

const mutablePolicy = {
  ...DEFAULT_FLAGS,
  roleAllowlist: ['student', 'instructor', 'admin'],
};

const MODEL_BY_MODE = {
  latency: process.env.FS_AI_MODEL_FAST || 'claude-3-5-haiku-20241022',
  quality: process.env.FS_AI_MODEL_QUALITY || 'claude-sonnet-4-20250514',
  cost: process.env.FS_AI_MODEL_COST || 'claude-3-5-haiku-20241022',
};

function parseJsonFromModelText(rawText, fallback = {}) {
  const raw = String(rawText || '').trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    try {
      return JSON.parse(m[0]);
    } catch {
      return fallback;
    }
  }
}

function redactPII(text) {
  return String(text || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted-phone]');
}

function sanitizePayload(payload, piiRedactionEnabled) {
  const raw = JSON.stringify(payload || {});
  const trimmed = raw.slice(0, 120_000);
  return piiRedactionEnabled ? redactPII(trimmed) : trimmed;
}

async function appendAudit(event) {
  const line = `${JSON.stringify({ ts: Date.now(), ...event })}\n`;
  try {
    await fs.appendFile(AI_AUDIT_FILE, line, 'utf8');
  } catch (e) {
    console.warn('[ai-audit] append failed', e?.message || e);
  }
}

function featureEnabled(feature, role) {
  if (!mutablePolicy.globalEnabled) return false;
  if (feature === 'supportChat') {
    if (Object.prototype.hasOwnProperty.call(mutablePolicy, feature)) {
      return Boolean(mutablePolicy[feature]);
    }
    return true;
  }
  if (role && !mutablePolicy.roleAllowlist.includes(role)) return false;
  if (Object.prototype.hasOwnProperty.call(mutablePolicy, feature)) {
    return Boolean(mutablePolicy[feature]);
  }
  return true;
}

async function runJsonTask({
  feature,
  mode = 'quality',
  role,
  system,
  userPayload,
  fallback,
  maxTokens = 1400,
}) {
  const start = Date.now();
  if (!featureEnabled(feature, role)) {
    const out = { ok: false, code: 403, error: `Feature disabled: ${feature}`, data: fallback, fallback: true };
    await appendAudit({ feature, mode, role, status: 'disabled', latencyMs: Date.now() - start });
    return out;
  }
  if (!anthropic) {
    const out = { ok: false, code: 503, error: 'ANTHROPIC_API_KEY not configured on server', data: fallback, fallback: true };
    await appendAudit({ feature, mode, role, status: 'missing_key', latencyMs: Date.now() - start });
    return out;
  }
  const model = MODEL_BY_MODE[mode] || MODEL_BY_MODE.quality;
  const safePayload = sanitizePayload(userPayload, mutablePolicy.piiRedaction);
  try {
    const msg = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: safePayload }],
    });
    const block = msg.content?.find((b) => b.type === 'text');
    const data = parseJsonFromModelText(block?.type === 'text' ? block.text : '', fallback);
    await appendAudit({
      feature,
      mode,
      role,
      status: 'ok',
      latencyMs: Date.now() - start,
      model,
      inputBytes: safePayload.length,
    });
    return { ok: true, data, provider: 'anthropic', model };
  } catch (e) {
    await appendAudit({
      feature,
      mode,
      role,
      status: 'error',
      latencyMs: Date.now() - start,
      model,
      error: e?.message || 'unknown',
    });
    return { ok: false, code: 500, error: e?.message || 'AI request failed', data: fallback, fallback: true };
  }
}

async function runSupportChat({ role, messages, context, locale, meta }) {
  const feature = 'supportChat';
  const start = Date.now();
  const fallbackReply =
    locale === 'ar'
      ? 'المساعد غير متصل حاليًا. راسلنا على admin@fairsharework.space وسنرد في أقرب وقت.'
      : locale === 'tr'
        ? 'Yardımcı şu an çevrimdışı. admin@fairsharework.space adresine yazın; en kısa sürede döneriz.'
        : 'Help is offline right now. Email admin@fairsharework.space and we will get back to you soon.';

  if (!featureEnabled(feature, role)) {
    await appendAudit({ feature, status: 'disabled', latencyMs: Date.now() - start });
    return { ok: false, code: 403, error: `Feature disabled: ${feature}`, reply: fallbackReply, fallback: true };
  }
  if (!anthropic) {
    await appendAudit({ feature, status: 'missing_key', latencyMs: Date.now() - start });
    return { ok: false, code: 503, error: 'ANTHROPIC_API_KEY not configured on server', reply: fallbackReply, fallback: true };
  }

  const hist = Array.isArray(messages) ? messages : [];
  const trimmed = hist
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .slice(-20)
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content).slice(0, 6000),
    }));
  if (!trimmed.length) {
    return { ok: false, code: 400, error: 'No messages', reply: fallbackReply, fallback: true };
  }

  const ctx = context === 'app' ? 'app' : 'marketing';
  const loc = ['ar', 'tr', 'en'].includes(locale) ? locale : 'en';
  const metaBlock = meta && typeof meta === 'object' ? JSON.stringify(meta).slice(0, 6000) : '{}';
  const system = [
    SUPPORT_CHAT_BEHAVIOR,
    '',
    '---',
    'KNOWLEDGE BASE (authoritative for FairShare facts):',
    FAIRSHARE_SUPPORT_KNOWLEDGE,
    '---',
    `Visitor context: ${ctx === 'app' ? 'User is inside the FairShare app (logged-in workspace).' : 'User is on the public marketing website.'}`,
    `Response locale: ${loc}`,
    `Session meta (JSON, may include projectSnapshot when in app): ${metaBlock}`,
  ].join('\n');
  const model = MODEL_BY_MODE.quality || MODEL_BY_MODE.latency;

  try {
    const msg = await anthropic.messages.create({
      model,
      max_tokens: 1600,
      system,
      messages: trimmed,
    });
    const block = msg.content?.find((b) => b.type === 'text');
    const reply = block?.type === 'text' ? String(block.text || '').trim() : '';
    await appendAudit({
      feature,
      status: 'ok',
      latencyMs: Date.now() - start,
      model,
      context: ctx,
      turns: trimmed.length,
    });
    return {
      ok: true,
      reply: reply || fallbackReply,
      provider: 'anthropic',
      model,
    };
  } catch (e) {
    await appendAudit({
      feature,
      status: 'error',
      latencyMs: Date.now() - start,
      model,
      error: e?.message || 'unknown',
    });
    return { ok: false, code: 500, error: e?.message || 'AI request failed', reply: fallbackReply, fallback: true };
  }
}

function registerAIFoundationRoutes(app) {
  app.get('/api/ai/policy', (_req, res) => {
    res.json({ ok: true, policy: mutablePolicy, models: MODEL_BY_MODE });
  });

  app.post('/api/ai/policy', (req, res) => {
    const next = req.body || {};
    for (const [k, v] of Object.entries(next)) {
      if (k === 'roleAllowlist' && Array.isArray(v)) {
        mutablePolicy.roleAllowlist = v.map((x) => String(x)).filter(Boolean);
      } else if (Object.prototype.hasOwnProperty.call(mutablePolicy, k)) {
        mutablePolicy[k] = Boolean(v);
      }
    }
    res.json({ ok: true, policy: mutablePolicy });
  });
}

export {
  anthropic,
  registerAIFoundationRoutes,
  runJsonTask,
  runSupportChat,
  parseJsonFromModelText,
};
