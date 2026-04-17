(function () {
  'use strict';

  var STORAGE_KEY = 'fairshare-site-lang';
  var SUPPORTED = ['en', 'ar', 'tr'];
  var T = null;

  function applyLang(lang) {
    if (!T) return;
    if (SUPPORTED.indexOf(lang) < 0) lang = 'en';
    var d = T[lang];

    document.documentElement.lang = lang === 'ar' ? 'ar' : lang === 'tr' ? 'tr' : 'en';
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';

    document.querySelectorAll('[data-i18n]').forEach(function (node) {
      var k = node.getAttribute('data-i18n');
      if (!k || d[k] == null) return;
      if (node.hasAttribute('data-i18n-html')) {
        node.innerHTML = d[k];
      } else if (node.hasAttribute('data-i18n-br')) {
        node.innerHTML = String(d[k]).replace(/\n/g, '<br>');
      } else {
        node.textContent = d[k];
      }
    });

    document.querySelectorAll('[data-i18n-alt]').forEach(function (node) {
      var k = node.getAttribute('data-i18n-alt');
      if (d[k]) node.setAttribute('alt', d[k]);
    });

    var meta = document.getElementById('meta-desc');
    if (meta && d.meta_desc) meta.setAttribute('content', d.meta_desc);
    var title = document.querySelector('title');
    if (title && d.meta_title) title.textContent = d.meta_title;

    var nav = document.getElementById('site-nav-links');
    if (nav && d.nav_aria) nav.setAttribute('aria-label', d.nav_aria);
    var sel = document.getElementById('site-lang');
    if (sel) {
      if (d.lang_label) sel.setAttribute('aria-label', d.lang_label);
      sel.value = lang;
    }

    document.querySelectorAll('a[data-mailto]').forEach(function (a) {
      var typ = a.getAttribute('data-mailto');
      var subj = d['mailto_' + typ] || d.mailto_support;
      a.setAttribute('href', 'mailto:admin@fairsharework.space?subject=' + encodeURIComponent(subj));
    });

    var fc = document.getElementById('footer-copy');
    if (fc && d.footer_copy) {
      fc.textContent = d.footer_copy.replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
    }

    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {}

    /* Do not toggle .nav-links.open here: on small screens that hides the whole nav (display:none until .open). */

    window.__FAIRSHARE_SITE_LANG__ = lang;
    if (typeof window.updateRoiCalculator === 'function') window.updateRoiCalculator();
  }

  function init() {
    var saved = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch (e) {}
    var initial = SUPPORTED.indexOf(saved) >= 0 ? saved : 'en';

    fetch('translations.json')
      .then(function (r) {
        if (!r.ok) throw new Error('translations');
        return r.json();
      })
      .then(function (data) {
        T = data;
        var sel = document.getElementById('site-lang');
        if (sel) {
          sel.addEventListener('change', function () {
            applyLang(sel.value || 'en');
          });
        }
        applyLang(initial);
      })
      .catch(function () {
        window.__FAIRSHARE_SITE_LANG__ = 'en';
        var fc = document.getElementById('footer-copy');
        if (fc && !fc.textContent.trim()) {
          fc.textContent = '© ' + new Date().getFullYear() + ' FairShare. All rights reserved.';
        }
        if (typeof window.updateRoiCalculator === 'function') window.updateRoiCalculator();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
