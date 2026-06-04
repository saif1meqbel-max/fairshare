/**
 * FairShare Help — support chatbot (marketing + app).
 * Live answers via POST /api/ai/support-chat; rich local knowledge when API unreachable.
 */
(function () {
  'use strict';

  var SUPPORT_EMAIL = 'admin@fairsharework.space';
  var API_PROBE = null;

  var STR = {
    en: {
      title: 'FairShare Help',
      subtitle: 'Answers about FairShare — usually in seconds',
      open: 'Open help chat',
      close: 'Close chat',
      placeholder: 'Ask a question…',
      send: 'Send',
      thinking: '…',
      welcomeMarketing:
        "Hi — I'm FairShare Help.\n\nI answer questions about group projects, fairness, tasks, docs, Analytics, AI, pricing, and privacy. Pick a topic below or type your own.",
      welcomeApp:
        "Hi — I'm FairShare Help.\n\nAsk about this project, your scores, tasks, teammates, Analytics, or anything in the workspace. Pick a suggestion or type below.",
      offlineNote: '(Answering from built-in help — live AI is reconnecting.)',
      emailCta: 'Email human support',
      chipsMarketing: ['Who is FairShare for?', 'How does fairness work?', 'Pricing', 'AI features'],
      chipsApp: ['Explain my fairness score', 'How do tasks affect my %?', 'Where is Analytics AI?', 'Invite a teammate'],
    },
    ar: {
      title: 'مساعدة FairShare',
      subtitle: 'إجابات عن FairShare — عادة خلال ثوانٍ',
      open: 'فتح المساعدة',
      close: 'إغلاق',
      placeholder: 'اكتب سؤالك…',
      send: 'إرسال',
      thinking: '…',
      welcomeMarketing:
        'مرحبًا — أنا مساعد FairShare.\n\nأجيب عن المشاريع الجماعية والعدالة والمهام والمستندات والتحليلات والذكاء الاصطناعي والأسعار والخصوصية. اختر موضوعًا أو اكتب سؤالك.',
      welcomeApp:
        'مرحبًا — أنا مساعد FairShare.\n\nاسأل عن هذا المشروع ودرجاتك والمهام والفريق والتحليلات. اختر اقتراحًا أو اكتب أدناه.',
      offlineNote: '(إجابة من مساعدة مدمجة — الذكاء الاصطناعي المباشر يعيد الاتصال.)',
      emailCta: 'راسل الدعم البشري',
      chipsMarketing: ['لمن FairShare؟', 'كيف تعمل العدالة؟', 'الأسعار', 'ميزات الذكاء الاصطناعي'],
      chipsApp: ['اشرح درجة العدالة', 'كيف تؤثر المهام على نسبتي؟', 'أين ذكاء التحليلات؟', 'دعوة زميل'],
    },
    tr: {
      title: 'FairShare Yardım',
      subtitle: 'FairShare hakkında yanıtlar — genelde saniyeler içinde',
      open: 'Yardımı aç',
      close: 'Kapat',
      placeholder: 'Sorunuzu yazın…',
      send: 'Gönder',
      thinking: '…',
      welcomeMarketing:
        'Merhaba — FairShare Yardım burada.\n\nGrup projeleri, adalet, görevler, belgeler, Analitik, YZ, fiyatlandırma ve gizlilik hakkında yanıt veririm. Bir öneri seçin veya yazın.',
      welcomeApp:
        'Merhaba — FairShare Yardım burada.\n\nBu proje, puanlarınız, görevler, ekip ve Analitik hakkında sorun. Öneri seçin veya yazın.',
      offlineNote: '(Yerleşik yardımdan yanıt — canlı YZ yeniden bağlanıyor.)',
      emailCta: 'İnsan desteğine e-posta',
      chipsMarketing: ['FairShare kimin için?', 'Adalet nasıl çalışır?', 'Fiyatlandırma', 'YZ özellikleri'],
      chipsApp: ['Adalet puanımı açıkla', 'Görevler %’imi nasıl etkiler?', 'Analitik YZ nerede?', 'Ekip arkadaşı davet'],
    },
  };

  /** Keyword-scored intents — substantive answers without generic email redirects. */
  var INTENTS = {
    en: [
      { keys: ['who', 'for', 'audience', 'student', 'university', 'school', 'lecturer', 'instructor'], a: "FairShare is built for:\n\n• **Students** in graded group projects (university, sixth form, college, high school cohorts)\n• **Instructors & tutors** who need visibility before hand-in — not just the final PDF\n• **Schools & universities** running pilots or departmental rollouts\n\nStudents get tasks, docs, chat, and clear contribution signals. Staff get Dashboard/Analytics and optional AI briefs. FairShare sits **beside your LMS** (Moodle, Canvas, etc.) for doing the work — not replacing official submission or grades." },
      { keys: ['what', 'is', 'fairshare', 'about', 'purpose'], a: "FairShare is a **group project workspace** that makes teamwork visible: who owns tasks, who writes in docs, who posts in chat, and how effort is spread over time.\n\nIt helps reduce free-rider problems and gives teams (and staff) evidence for fair conversations — without replacing your LMS." },
      { keys: ['fair', 'fairness', 'index', 'contribut', 'score', 'percent', 'free', 'rider'], a: "**Contribution %** comes from real work: tasks completed, document writing/edits, comments, and on-time delivery — logged in the product.\n\nThe **fairness index** in Analytics reflects how evenly those percentages are spread across members. Wide gaps are a signal to talk early, not an automatic penalty.\n\nOpen **Analytics** for breakdowns, flags, and optional AI explainability. Instructors decide if data informs marking — per institutional policy." },
      { keys: ['task', 'kanban', 'assign', 'due', 'overdue'], a: "Go to the **Tasks** tab:\n1. Create a task with a clear name\n2. Assign an owner and due date\n3. Move status (e.g. in progress → done)\n\nKanban and list views both work. Completed tasks feed your contribution score. Overdue tasks show up in Analytics health signals." },
      { keys: ['doc', 'document', 'slide', 'sheet', 'write', 'editor'], a: "Open **Documents** and choose:\n• **Document** — rich text editor\n• **Slides** — deck builder\n• **Sheet** — spreadsheet-style\n\nWriting and edits count toward contribution. You may see an optional **AI writing estimate** bar (advisory only). The editor can also suggest improvements when AI is enabled on your server." },
      { keys: ['chat', 'message', 'channel'], a: "**Chat** keeps coordination next to the work. Use project channels (e.g. general), @mention owners, and end threads with a next step.\n\nMessage patterns feed **communication intelligence** in Analytics AI (optional)." },
      { keys: ['invite', 'join', 'member', 'team', 'accept'], a: "To join a project:\n1. Open **Invites** and accept a pending invite, or\n2. Ask a teammate to add your email when creating/editing the project\n\nYour account email must match. Email delivery depends on your host configuring outbound mail (e.g. Resend)." },
      { keys: ['analytic', 'report', 'dashboard', 'export'], a: "**Dashboard** — quick project health and contribution preview.\n**Analytics** — fairness index, ranked scores, breakdown by category, fairness flags, deadlines.\n\nYou can export/report from Analytics. Optional **AI packs** (insights, planning, integrity, institutional) run from Analytics buttons when your API server and policy allow." },
      { keys: ['ai', 'artificial', 'copilot', 'intelligence', 'coach'], a: "Optional **AI in Analytics** (advisory, not auto-grading):\n• Coaching & health — contribution narrative, group risk, student next steps\n• Integrity — fairness explainability, moderation notes, writing authenticity hints\n• Planning — planner, communication balance, team-matching ideas\n• Institutional — exec summary, LMS mapping hints, compliance, parent-friendly copy\n\nRequires FairShare API + keys; your school can toggle policy. This chat widget is separate — ask me FairShare questions anytime." },
      { keys: ['price', 'cost', 'free', 'pilot', 'tier', 'campus', 'team', 'starter'], a: "**Starter** — free pilot for a class (~25 seats, adjust with sales): tasks, docs, chat, activity.\n**Team** — quoted for departments/faculties: higher caps, priority support, IT/DPO docs.\n**Campus** — custom for institutions: DPA discussions, training, SSO roadmap, reporting.\n\nSee **Pricing** on the website or email " + SUPPORT_EMAIL + " for a quote." },
      { keys: ['privacy', 'gdpr', 'data', 'security', 'pii', 'legal'], a: "We document security, subprocessors, and privacy on the website (**Security & privacy**, **Privacy policy**). FairShare is designed for UK GDPR / PDPL-style institutional conversations; your DPO confirms fit.\n\nAI may redact PII when policy requires. I can't give legal advice — involve your institution for contracts and retention." },
      { keys: ['lms', 'moodle', 'canvas', 'blackboard', 'classroom', 'submit', 'grade'], a: "FairShare does **not** replace your LMS. Students still submit and receive grades there.\n\nFairShare handles **in-project execution**: ownership, docs, chat, contribution evidence. Many teams export or hand in final work elsewhere while using FairShare during the project." },
      { keys: ['login', 'sign', 'password', 'account', 'auth'], a: "Sign in with your FairShare account (Supabase auth). If you're stuck:\n• Check email/password\n• Use password reset from the login screen\n• Confirm you accepted project **Invites**\n\nStill blocked? Email " + SUPPORT_EMAIL + "." },
      { keys: ['help', 'support', 'contact', 'email', 'human'], a: "You're already in the right place for product questions. For account issues, contracts, or bugs we need to trace, email **" + SUPPORT_EMAIL + "** — we aim to respond as soon as we can." },
      { keys: ['video', 'call', 'daily', 'meeting'], a: "When your deployment configures **Daily.co** on the API server, projects may offer video rooms for team calls. If you don't see video, your host may not have enabled it yet." },
    ],
    ar: [
      { keys: ['من', 'لمن', 'طلاب', 'جامعة', 'مدرسة', 'معلم'], a: "FairShare مخصص لـ:\n\n• **الطلاب** في مشاريع جماعية مقيّمة\n• **المعلمين والمحاضرين** لرؤية الفريق قبل التسليم\n• **المدارس والجامعات** للتجارب والتوسع\n\nيعمل بجانب نظام إدارة التعلم وليس بديلًا عن التسليم الرسمي أو الدرجات." },
      { keys: ['ما', 'fairshare', 'ماذا'], a: "FairShare **مساحة عمل للمشاريع الجماعية** تجعل المساهمة مرئية: مهام، مستندات، دردشة، وتوزيع الجهد — لتقليل راكبي المجان وتسهيل حوار عادل." },
      { keys: ['عدالة', 'مساهمة', 'نسبة', 'درجة'], a: "**نسبة المساهمة** من عمل مسجّل: مهام، كتابة وتعديل مستندات، تعليقات.\n**مؤشر العدالة** يعكس مدى توازن النسب بين الأعضاء — إشارة للنقاش وليس عقوبة آلية. راجع تبويب **Analytics**." },
      { keys: ['سعر', 'مجاني', 'تكلفة'], a: "**Starter** تجريبي مجاني، **Team** للأقسام (عرض سعر)، **Campus** للمؤسسات. قسم الأسعار في الموقع أو " + SUPPORT_EMAIL },
      { keys: ['خصوصية', 'أمان', 'بيانات'], a: "راجع صفحتي **Security & privacy** و**Privacy policy** على الموقع. للامتثال القانوني راجع مسؤول حماية البيانات في مؤسستك." },
      { keys: ['ذكاء', 'ai', 'تحليلات'], a: "ذكاء اصطناعي **اختياري** في **Analytics** — توجيه وتخطيط وإشراف — دون وضع درجات تلقائيًا. المدرسة تتحكم في التفعيل." },
    ],
    tr: [
      { keys: ['kim', 'için', 'öğrenci', 'üniversite', 'okul', 'öğretmen'], a: "FairShare şunlar içindir:\n\n• **Öğrenciler** — notlu grup projeleri\n• **Öğretim üyeleri** — teslimden önce görünürlük\n• **Kurumlar** — pilot ve yaygınlaştırma\n\nLMS'in yanında çalışır; resmi teslim/notun yerini almaz." },
      { keys: ['nedir', 'fairshare', 'ne'], a: "FairShare, ekip çalışmasını görünür kılan bir **grup proje çalışma alanıdır**: görevler, belgeler, sohbet ve katkı dağılımı." },
      { keys: ['adalet', 'katkı', 'puan', 'yüzde'], a: "**Katkı %** tamamlanan görevler, yazım/düzenleme ve etkinlikten gelir. **Adalet endeksi** payların ne kadar dengeli olduğunu gösterir — konuşma sinyali, otomatik not değil. **Analytics** sekmesine bakın." },
      { keys: ['fiyat', 'ücretsiz', 'maliyet'], a: "**Starter** ücretsiz pilot, **Team** bölüm teklifi, **Campus** kurum özelleştirmesi. Sitedeki fiyatlandırma veya " + SUPPORT_EMAIL },
      { keys: ['gizlilik', 'güvenlik', 'veri'], a: "Sitedeki **Security & privacy** ve **Privacy policy** sayfalarına bakın. Kurumsal uyum için KVK/GDPR ekibinize danışın." },
      { keys: ['yz', 'ai', 'analitik'], a: "**Analytics**'te isteğe bağlı **YZ** — koçluk, planlama, bütünlük — otomatik not vermez." },
    ],
  };

  function locale() {
    if (typeof window.__FAIRSHARE_SITE_LANG__ === 'string' && STR[window.__FAIRSHARE_SITE_LANG__]) {
      return window.__FAIRSHARE_SITE_LANG__;
    }
    var htmlLang = (document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
    return STR[htmlLang] ? htmlLang : 'en';
  }

  function t(key) {
    var loc = locale();
    return (STR[loc] && STR[loc][key]) || STR.en[key] || key;
  }

  function scriptEl() {
    return document.querySelector('script[data-fs-chat-context]');
  }

  function chatContext() {
    var s = scriptEl();
    var c = s && s.getAttribute('data-fs-chat-context');
    return c === 'app' ? 'app' : 'marketing';
  }

  function apiBases() {
    var list = [];
    function add(b) {
      b = String(b || '').replace(/\/$/, '');
      if (b && list.indexOf(b) < 0) list.push(b);
    }
    if (typeof window.FSB === 'object' && typeof window.FSB.apiBase === 'function') {
      add(window.FSB.apiBase());
    }
    if (typeof window.FAIRSHARE_API_BASE === 'string') add(window.FAIRSHARE_API_BASE);
    var s = scriptEl();
    if (s) add(s.getAttribute('data-fs-api-base'));
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      add(window.location.origin);
    }
    add('http://localhost:3840');
    add('http://127.0.0.1:3840');
    return list;
  }

  function sessionMeta() {
    var meta = { context: chatContext() };
    if (chatContext() === 'app') {
      try {
        if (typeof currentProject !== 'undefined' && currentProject) {
          meta.projectName = String(currentProject.name || '').slice(0, 120);
          meta.projectId = currentProject.id;
          meta.deadline = currentProject.deadline || null;
          meta.memberCount = (currentProject.members || []).length;
        }
        if (typeof currentUser !== 'undefined' && currentUser) {
          meta.userRole = String(currentUser.role || 'student');
          meta.userName = String(currentUser.name || '').slice(0, 80);
        }
        var activePage = document.querySelector('.page.active');
        if (activePage && activePage.id) {
          meta.activeTab = String(activePage.id).replace(/^page-/, '');
        }
        if (typeof buildAISnapshot === 'function' && currentProject) {
          var snap = buildAISnapshot();
          if (snap) {
            meta.projectSnapshot = {
              metrics: snap.metrics,
              fairness: snap.fairness,
              me: snap.me,
              contributionSummary: (snap.contribution || []).slice(0, 12).map(function (c) {
                return { name: c.name, pct: c.pct, tasksDone: c.taskCount };
              }),
            };
          }
        }
      } catch (_e) {}
    }
    return meta;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBotHtml(text) {
    var safe = escapeHtml(String(text || ''));
    safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/\n/g, '<br>');
    return safe;
  }

  function knowledgeAnswer(userText) {
    var q = String(userText || '').toLowerCase().replace(/[^\w\s\u0600-\u06FF]/g, ' ');
    var loc = locale();
    var bank = INTENTS[loc] || INTENTS.en;
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < bank.length; i++) {
      var intent = bank[i];
      var score = 0;
      for (var k = 0; k < intent.keys.length; k++) {
        if (q.indexOf(intent.keys[k]) >= 0) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = intent;
      }
    }
    if (best && bestScore >= 1) return best.a;
    if (/^(hi|hello|hey|yo|merhaba|selam|مرحبا|السلام|اهلا)\b/.test(q)) {
      return chatContext() === 'app' ? t('welcomeApp') : t('welcomeMarketing');
    }
    var enBest = INTENTS.en;
    best = null;
    bestScore = 0;
    for (var j = 0; j < enBest.length; j++) {
      var intentEn = enBest[j];
      var sc = 0;
      for (var kk = 0; kk < intentEn.keys.length; kk++) {
        if (q.indexOf(intentEn.keys[kk]) >= 0) sc += 1;
      }
      if (sc > bestScore) {
        bestScore = sc;
        best = intentEn;
      }
    }
    if (best && bestScore >= 2) return best.a;
    return (
      "I focus on **FairShare** only. Try asking about:\n• Who it's for\n• Fairness & contribution scores\n• Tasks, docs, or chat\n• Analytics & AI\n• Pricing or privacy\n\nOr tap a suggestion below. For account issues: " +
      SUPPORT_EMAIL
    );
  }

  function postSupportChat(payload) {
    var bases = apiBases();
    var idx = 0;
    function attempt() {
      if (idx >= bases.length) {
        return Promise.reject(new Error('no_api'));
      }
      var base = bases[idx++];
      return fetch(base + '/api/ai/support-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) {
        return r.json().then(function (j) {
          if (j && typeof j.reply === 'string' && j.reply.trim()) {
            return { reply: j.reply.trim(), live: r.ok && !j.fallback, base: base };
          }
          if (r.ok) return attempt();
          return attempt();
        });
      }).catch(function () {
        return attempt();
      });
    }
    return attempt();
  }

  function probeApi() {
    if (API_PROBE) return API_PROBE;
    var bases = apiBases();
    API_PROBE = new Promise(function (resolve) {
      var i = 0;
      function tryOne() {
        if (i >= bases.length) {
          resolve(false);
          return;
        }
        fetch(bases[i++] + '/api/health', { method: 'GET' })
          .then(function (r) {
            if (r.ok) resolve(true);
            else tryOne();
          })
          .catch(tryOne);
      }
      tryOne();
    });
    return API_PROBE;
  }

  function injectStyles() {
    if (document.getElementById('fs-support-chat-styles')) return;
    var css = document.createElement('style');
    css.id = 'fs-support-chat-styles';
    css.textContent =
      '#fs-support-chat-root{position:fixed;z-index:99990;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px}' +
      '#fs-support-chat-root *{box-sizing:border-box}' +
      '.fs-chat-launcher{position:fixed;bottom:22px;right:22px;width:58px;height:58px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#00d4aa 0%,#4f7cff 100%);color:#081018;font-size:24px;box-shadow:0 8px 32px rgba(0,212,170,.25),0 4px 16px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;transition:transform .15s,box-shadow .15s}' +
      '.fs-chat-launcher:hover{transform:scale(1.06);box-shadow:0 12px 36px rgba(0,212,170,.35)}' +
      'html[dir=rtl] .fs-chat-launcher{right:auto;left:22px}' +
      '.fs-chat-panel{position:fixed;bottom:92px;right:22px;width:min(400px,calc(100vw - 24px));height:min(560px,calc(100vh - 110px));background:#0f1419;border:1px solid rgba(255,255,255,.12);border-radius:20px;box-shadow:0 24px 64px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden;opacity:0;pointer-events:none;transform:translateY(16px) scale(.98);transition:opacity .22s ease,transform .22s ease}' +
      '.fs-chat-panel.open{opacity:1;pointer-events:auto;transform:translateY(0) scale(1)}' +
      'html[dir=rtl] .fs-chat-panel{right:auto;left:22px}' +
      '.fs-chat-head{padding:16px 48px 14px 16px;border-bottom:1px solid rgba(255,255,255,.08);background:linear-gradient(180deg,#151c28,#111827)}' +
      'html[dir=rtl] .fs-chat-head{padding:16px 16px 14px 48px}' +
      '.fs-chat-head h3{margin:0;font-size:16px;font-weight:700;color:#f0f4ff;display:flex;align-items:center;gap:8px}' +
      '.fs-chat-status{width:8px;height:8px;border-radius:50%;background:#64748b;flex-shrink:0}' +
      '.fs-chat-status.live{background:#00d4aa;box-shadow:0 0 8px rgba(0,212,170,.6)}' +
      '.fs-chat-head p{margin:6px 0 0;font-size:12px;color:#8896b3;line-height:1.45}' +
      '.fs-chat-close{position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,.06);border:none;color:#94a3b8;cursor:pointer;font-size:18px;line-height:1}' +
      'html[dir=rtl] .fs-chat-close{right:auto;left:12px}' +
      '.fs-chat-msgs{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:12px;background:#0a0d12}' +
      '.fs-chat-row{display:flex;gap:10px;align-items:flex-end;max-width:100%}' +
      '.fs-chat-row.user{flex-direction:row-reverse}' +
      '.fs-chat-avatar{width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800}' +
      '.fs-chat-avatar.bot{background:linear-gradient(135deg,#00d4aa,#4f7cff);color:#081018}' +
      '.fs-chat-avatar.user{background:#1e293b;color:#94a3b8}' +
      '.fs-chat-bubble{max-width:calc(100% - 38px);padding:11px 14px;border-radius:16px;font-size:13px;line-height:1.55;word-break:break-word}' +
      '.fs-chat-bubble.user{background:linear-gradient(135deg,rgba(0,212,170,.22),rgba(79,124,255,.15));color:#f0f4ff;border-bottom-right-radius:4px}' +
      'html[dir=rtl] .fs-chat-bubble.user{border-bottom-right-radius:16px;border-bottom-left-radius:4px}' +
      '.fs-chat-bubble.bot{background:#1a2236;color:#e2e8f0;border:1px solid rgba(255,255,255,.06);border-bottom-left-radius:4px}' +
      '.fs-chat-bubble.bot strong{color:#fff;font-weight:650}' +
      '.fs-chat-bubble.bot .fs-offline-tag{display:block;margin-top:8px;font-size:10px;color:#8896b3;font-style:italic}' +
      '.fs-chat-typing .fs-chat-bubble{padding:14px 18px}' +
      '.fs-chat-dots span{display:inline-block;width:6px;height:6px;margin:0 2px;background:#64748b;border-radius:50%;animation:fsChatDot 1.2s infinite}' +
      '.fs-chat-dots span:nth-child(2){animation-delay:.15s}' +
      '.fs-chat-dots span:nth-child(3){animation-delay:.3s}' +
      '@keyframes fsChatDot{0%,80%,100%{opacity:.35;transform:translateY(0)}40%{opacity:1;transform:translateY(-4px)}}' +
      '.fs-chat-chips{display:flex;flex-wrap:wrap;gap:8px;padding:0 4px 4px}' +
      '.fs-chat-chip{border:1px solid rgba(0,212,170,.35);background:rgba(0,212,170,.08);color:#b8f5e8;border-radius:100px;padding:8px 14px;font-size:12px;cursor:pointer;font-family:inherit;transition:background .15s,border-color .15s}' +
      '.fs-chat-chip:hover{background:rgba(0,212,170,.18);border-color:rgba(0,212,170,.55)}' +
      '.fs-chat-foot{padding:12px 14px 14px;border-top:1px solid rgba(255,255,255,.08);background:#111827}' +
      '.fs-chat-form{display:flex;gap:8px;align-items:flex-end}' +
      '.fs-chat-input{flex:1;border:1px solid rgba(255,255,255,.14);background:#0a0d12;color:#f0f4ff;border-radius:12px;padding:11px 14px;font-size:14px;resize:none;min-height:44px;max-height:120px;font-family:inherit;line-height:1.4}' +
      '.fs-chat-input:focus{outline:none;border-color:#00d4aa;box-shadow:0 0 0 2px rgba(0,212,170,.2)}' +
      '.fs-chat-send{border:none;background:#00d4aa;color:#081018;font-weight:700;border-radius:12px;padding:12px 16px;cursor:pointer;font-size:13px;min-width:72px;height:44px}' +
      '.fs-chat-send:disabled{opacity:.45;cursor:not-allowed}' +
      '.fs-chat-email{font-size:11px;text-align:center;margin:8px 0 0}' +
      '.fs-chat-email a{color:#00d4aa;text-decoration:none;font-weight:600}' +
      '.fs-chat-email a:hover{text-decoration:underline}';
    document.head.appendChild(css);
  }

  function init() {
    injectStyles();
    var ctx = chatContext();
    var history = [];
    var busy = false;
    var open = false;
    var liveAi = false;
    var welcomed = false;

    var root = document.createElement('div');
    root.id = 'fs-support-chat-root';

    var launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'fs-chat-launcher';
    launcher.setAttribute('aria-label', t('open'));
    launcher.innerHTML = '💬';

    var panel = document.createElement('div');
    panel.className = 'fs-chat-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', t('title'));

    var head = document.createElement('div');
    head.className = 'fs-chat-head';
    head.innerHTML =
      '<h3><span class="fs-chat-status" id="fs-chat-status" aria-hidden="true"></span>' +
      escapeHtml(t('title')) +
      '</h3><p>' +
      escapeHtml(t('subtitle')) +
      '</p>';

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'fs-chat-close';
    closeBtn.setAttribute('aria-label', t('close'));
    closeBtn.textContent = '×';
    head.appendChild(closeBtn);

    var msgs = document.createElement('div');
    msgs.className = 'fs-chat-msgs';
    msgs.setAttribute('role', 'log');
    msgs.setAttribute('aria-live', 'polite');

    var chipsWrap = document.createElement('div');
    chipsWrap.className = 'fs-chat-chips';
    chipsWrap.id = 'fs-chat-chips';

    var foot = document.createElement('div');
    foot.className = 'fs-chat-foot';

    var form = document.createElement('form');
    form.className = 'fs-chat-form';

    var input = document.createElement('textarea');
    input.className = 'fs-chat-input';
    input.rows = 1;
    input.placeholder = t('placeholder');
    input.setAttribute('aria-label', t('placeholder'));

    var sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'fs-chat-send';
    sendBtn.textContent = t('send');

    var emailLine = document.createElement('p');
    emailLine.className = 'fs-chat-email';
    emailLine.innerHTML =
      '<a href="mailto:' +
      SUPPORT_EMAIL +
      '?subject=FairShare%20%E2%80%94%20Support">' +
      escapeHtml(t('emailCta')) +
      '</a>';

    form.appendChild(input);
    form.appendChild(sendBtn);
    foot.appendChild(form);
    foot.appendChild(emailLine);
    panel.appendChild(head);
    panel.appendChild(msgs);
    panel.appendChild(foot);
    root.appendChild(launcher);
    root.appendChild(panel);
    document.body.appendChild(root);

    var statusDot = document.getElementById('fs-chat-status');

    function scrollMsgs() {
      msgs.scrollTop = msgs.scrollHeight;
    }

    function addMessage(role, text, opts) {
      opts = opts || {};
      var row = document.createElement('div');
      row.className = 'fs-chat-row ' + (role === 'user' ? 'user' : 'bot');
      var av = document.createElement('div');
      av.className = 'fs-chat-avatar ' + (role === 'user' ? 'user' : 'bot');
      av.textContent = role === 'user' ? 'You' : 'FS';
      av.setAttribute('aria-hidden', 'true');
      var bubble = document.createElement('div');
      bubble.className = 'fs-chat-bubble ' + (role === 'user' ? 'user' : 'bot');
      if (role === 'user') {
        bubble.textContent = text;
      } else {
        bubble.innerHTML = formatBotHtml(text);
        if (opts.offline) {
          var tag = document.createElement('span');
          tag.className = 'fs-offline-tag';
          tag.textContent = t('offlineNote');
          bubble.appendChild(tag);
        }
      }
      row.appendChild(av);
      row.appendChild(bubble);
      msgs.appendChild(row);
      scrollMsgs();
      return row;
    }

    function showTyping() {
      var row = document.createElement('div');
      row.className = 'fs-chat-row bot fs-chat-typing';
      row.id = 'fs-chat-typing';
      row.innerHTML =
        '<div class="fs-chat-avatar bot" aria-hidden="true">FS</div>' +
        '<div class="fs-chat-bubble bot"><div class="fs-chat-dots" aria-label="Typing">' +
        '<span></span><span></span><span></span></div></div>';
      msgs.appendChild(row);
      scrollMsgs();
    }

    function hideTyping() {
      var el = document.getElementById('fs-chat-typing');
      if (el) el.remove();
    }

    function renderChips() {
      chipsWrap.innerHTML = '';
      var loc = locale();
      var list =
        ctx === 'app'
          ? (STR[loc] && STR[loc].chipsApp) || STR.en.chipsApp
          : (STR[loc] && STR[loc].chipsMarketing) || STR.en.chipsMarketing;
      list.forEach(function (label) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fs-chat-chip';
        btn.textContent = label;
        btn.addEventListener('click', function () {
          if (busy) return;
          input.value = label;
          form.requestSubmit();
        });
        chipsWrap.appendChild(btn);
      });
      msgs.appendChild(chipsWrap);
      scrollMsgs();
    }

    function showWelcome() {
      if (welcomed) return;
      welcomed = true;
      var welcome = ctx === 'app' ? t('welcomeApp') : t('welcomeMarketing');
      history.push({ role: 'assistant', content: welcome });
      addMessage('bot', welcome);
      renderChips();
    }

    function setOpen(next) {
      open = next;
      panel.classList.toggle('open', open);
      launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        showWelcome();
        probeApi().then(function (ok) {
          liveAi = ok;
          if (statusDot) statusDot.classList.toggle('live', ok);
        });
        setTimeout(function () {
          input.focus();
        }, 200);
      }
    }

    function sendUserMessage(text) {
      if (busy || !text.trim()) return;
      text = text.trim();
      input.value = '';
      var chips = document.getElementById('fs-chat-chips');
      if (chips) chips.remove();
      addMessage('user', text);
      history.push({ role: 'user', content: text });
      busy = true;
      sendBtn.disabled = true;
      showTyping();

      var payload = {
        messages: history.filter(function (m) {
          return m.role === 'user' || m.role === 'assistant';
        }),
        context: ctx,
        locale: locale(),
        meta: sessionMeta(),
        requesterRole:
          typeof currentUser !== 'undefined' && currentUser
            ? String(currentUser.role || 'student')
            : '',
      };

      postSupportChat(payload)
        .then(function (res) {
          hideTyping();
          var reply = res.reply;
          liveAi = res.live;
          if (statusDot) statusDot.classList.toggle('live', liveAi);
          history.push({ role: 'assistant', content: reply });
          addMessage('bot', reply, { offline: !res.live });
        })
        .catch(function () {
          hideTyping();
          if (statusDot) statusDot.classList.remove('live');
          var reply = knowledgeAnswer(text);
          history.push({ role: 'assistant', content: reply });
          addMessage('bot', reply, { offline: true });
        })
        .finally(function () {
          busy = false;
          sendBtn.disabled = false;
          sendBtn.textContent = t('send');
          input.focus();
        });
    }

    launcher.addEventListener('click', function () {
      setOpen(!open);
    });
    closeBtn.addEventListener('click', function () {
      setOpen(false);
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      sendUserMessage(input.value);
    });

    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        form.requestSubmit();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
