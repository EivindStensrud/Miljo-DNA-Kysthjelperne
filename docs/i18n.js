/* i18n.js - tiny translation layer. You keep writing the site in ENGLISH (index.html / script.js).
 *
 * HOW IT WORKS
 *   - The language is Norwegian ("no") unless the visitor chose English ("en") with the NO | EN switch in the header
 *     (the choice is remembered in the browser) or opened the page with ?lang=en / ?lang=no.
 *   - Every piece of text the page shows (also text that script.js creates later) is looked up in the dictionary
 *     docs/lang/no.js. English text = the key, Norwegian text = the value. A text that is not in the dictionary
 *     stays English, so nothing breaks when you add new English text.
 *   - Dictionary keys with {name} are patterns:  "{n} samples": "{n} prøver"  (the captured parts are translated too).
 *     {n:d} in a key only matches a number:  "{n:d} samples": "{n} prøver"  (write plain {n} in the Norwegian text).
 *   - In script.js, text that is put together from several pieces can use  t("English with {n}", {n: 5}).
 *   - Chart.js labels (drawn on a canvas) are translated automatically as well.
 *
 * WHEN YOU HAVE ADDED OR CHANGED ENGLISH TEXT
 *   Open the page with  ?i18n=debug  (Norwegian mode). A button "Untranslated (N)" appears at the bottom left;
 *   it downloads a list in the dictionary format. Translate the values and paste the lines into docs/lang/no.js.
 *   (Numbers are shown as {n}, so one line covers all numbers. Names of stations, species and so on may also appear
 *   in the list - ignore those.)
 */
(function () {
    'use strict';
    const STORE = 'kyst_lang';
    const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
    const SEPARATORS = [' · ', ' – '];
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'CODE']);

    const params = new URLSearchParams(location.search);
    let lang = params.get('lang');
    try {
        if (lang === 'en' || lang === 'no') localStorage.setItem(STORE, lang);
        else lang = localStorage.getItem(STORE);
    } catch (e) { /* storage blocked: fine, default applies */ }
    if (lang !== 'en' && lang !== 'no') lang = 'no';                 // default: Norwegian
    const debug = params.get('i18n') === 'debug';

    const dict = Object.create(null);                                // all entries: English -> Norwegian
    const plainKeys = Object.create(null);                           // "{n:d} x" is also reachable as "{n} x" (for t())
    let patterns = [];                                               // compiled entries that contain {name}
    const missing = new Map();                                       // debug: generalised English text -> example

    const I18N = {
        lang,
        add(map) {
            Object.assign(dict, map);
            for (const k of Object.keys(map)) if (k.includes(':d}')) plainKeys[k.replace(/:d\}/g, '}')] = map[k];
            compile();
        },
        setLang(l) {
            try { localStorage.setItem(STORE, l); } catch (e) { /* ignore */ }
            const u = new URL(location.href);
            u.searchParams.delete('lang');
            location.href = u.toString();
        },
        t, tr
    };
    window.I18N = I18N;
    window.t = t;

    // ---- dictionary ------------------------------------------------------------------------------------------
    function compile() {
        patterns = [];
        for (const key of Object.keys(dict)) {
            if (!/\{\w+(?::d)?\}/.test(key)) continue;
            const names = [];
            const src = key.split(/(\{\w+(?::d)?\})/).map(part => {
                const m = part.match(/^\{(\w+)(:d)?\}$/);
                if (m) { names.push(m[1]); return m[2] ? '(\\d+(?:[.,]\\d+)?)' : '(.+?)'; }
                return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }).join('');
            patterns.push({ key, names, rx: new RegExp('^' + src + '$'), weight: key.replace(/\{\w+(?::d)?\}/g, '').length });
        }
        patterns.sort((a, b) => b.weight - a.weight);                 // most specific pattern first
    }

    function fill(text, vars) {
        return text.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m));
    }

    // t("English text {n}", {n: 3}): for text that script.js assembles itself
    function t(key, vars) {
        const hit = dict[key] !== undefined ? dict[key] : plainKeys[key];
        const text = lang === 'no' && hit !== undefined && hit !== '' ? hit : key;
        return vars ? fill(text, vars) : text;
    }

    // ---- lookup of one piece of text -----------------------------------------------------------------------------
    function lookup(core) {
        const direct = dict[core];
        if (direct !== undefined && direct !== '') return direct;
        for (const p of patterns) {
            const m = p.rx.exec(core);
            if (!m) continue;
            const vars = {};
            p.names.forEach((n, i) => { vars[n] = translateCore(m[i + 1]); });
            return fill(dict[p.key], vars);
        }
        const cnt = core.match(/^(.*\S) \((\d+)\)$/);                 // "Fish eDNA 2022 (130)"
        if (cnt) {
            const base = lookup(cnt[1]);
            if (base !== null) return `${base} (${cnt[2]})`;
        }
        for (const sep of SEPARATORS) {                              // "12 samples · 2 without coordinates"
            if (!core.includes(sep)) continue;
            let hit = false;
            const parts = core.split(sep).map(part => { const r = lookup(part); if (r !== null) hit = true; return r === null ? part : r; });
            if (hit) return parts.join(sep);
        }
        return null;
    }

    function translateCore(core) {
        const r = lookup(core);
        return r === null ? core : r;
    }

    function note(core) {
        if (!debug || !/[A-Za-z]{3}/.test(core) || /^[\d\s.,:;%‰µ+\-–→·/()]+$/.test(core)) return;
        const pieces = SEPARATORS.some(s => core.includes(s)) ? core.split(/ · | – /) : [core];
        pieces.forEach(p => {
            if (lookup(p) !== null || !/[A-Za-z]{3}/.test(p)) return;
            const general = p.replace(/\d+(?:[.,]\d+)?/g, '{n}');
            if (!missing.has(general)) missing.set(general, p);
        });
    }

    // translate a text; keeps leading / trailing white space
    function tr(s) {
        if (lang !== 'no' || typeof s !== 'string') {
            if (debug && typeof s === 'string') note(s.replace(/\s+/g, ' ').trim());
            return s;
        }
        const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
        const core = m[2].replace(/\s+/g, ' ');
        if (!core) return s;
        const r = lookup(core);
        if (r === null) { note(core); return s; }
        return m[1] + r + m[3];
    }

    // ---- DOM ------------------------------------------------------------------------------------------------------
    const lastSet = new WeakMap();                                   // node -> text we wrote (avoids loops)

    function textNode(n) {
        const v = n.nodeValue;
        if (!v || !v.trim() || lastSet.get(n) === v) return;
        const out = tr(v);
        if (out !== v) { lastSet.set(n, out); n.nodeValue = out; }
    }

    function attrs(el) {
        for (const a of ATTRS) {
            const v = el.getAttribute && el.getAttribute(a);
            if (v) {
                const out = tr(v);
                if (out !== v) el.setAttribute(a, out);
            }
        }
    }

    function walk(node) {
        if (node.nodeType === 3) { if (!(node.parentNode && SKIP_TAGS.has(node.parentNode.nodeName))) textNode(node); return; }
        if (node.nodeType !== 1 || SKIP_TAGS.has(node.nodeName) || node.hasAttribute('data-no-i18n')) return;
        attrs(node);
        for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
    }

    function start() {
        document.documentElement.lang = lang === 'no' ? 'nb' : 'en';
        const meta = document.querySelector('meta[name="description"]');
        if (meta) meta.content = tr(meta.content);
        document.title = tr(document.title);
        walk(document.documentElement);
        if (lang === 'no') document.querySelectorAll('[data-href-no]').forEach(a => { a.href = a.dataset.hrefNo; });
        wireSwitch();
        if (debug) debugButton();
    }

    const observer = new MutationObserver(records => {
        for (const r of records) {
            if (r.type === 'childList') r.addedNodes.forEach(n => { if (n.nodeType === 1 || n.nodeType === 3) walk(n); });
            else if (r.type === 'characterData') { if (!(r.target.parentNode && SKIP_TAGS.has(r.target.parentNode.nodeName))) textNode(r.target); }
            else if (r.type === 'attributes') attrs(r.target);
        }
    });
    if (lang === 'no' || debug) {                                      // English needs no translating
        observer.observe(document.documentElement, {
            childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS
        });
    }

    // ---- Chart.js: text on a canvas is not part of the DOM ----------------------------------------------------
    function localizeConfig(o, depth) {
        if (!o || typeof o !== 'object' || depth > 8) return;
        for (const k of Object.keys(o)) {
            const v = o[k];
            if (typeof v === 'string') { if (k === 'label' || k === 'text' || k === 'title') o[k] = tr(v); }
            else if (Array.isArray(v)) {
                if (k === 'labels') o[k] = v.map(x => (typeof x === 'string' ? tr(x) : x));
                else if (k !== 'data') v.forEach(x => localizeConfig(x, depth + 1));
            } else if (v && typeof v === 'object' && k !== 'data') localizeConfig(v, depth + 1);
        }
        if (o.data && typeof o.data === 'object' && !Array.isArray(o.data)) localizeConfig(o.data, depth + 1);
    }
    if (window.Chart && !window.Chart.__i18n) {
        const Orig = window.Chart;
        window.Chart = new Proxy(Orig, {
            construct(target, args) { if (args[1]) localizeConfig(args[1], 0); return Reflect.construct(target, args); }
        });
        window.Chart.__i18n = true;
    }

    // ---- language switch (buttons with data-lang in index.html) ---------------------------------------------------
    function wireSwitch() {
        document.querySelectorAll('[data-lang]').forEach(b => {
            const on = b.dataset.lang === lang;
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            b.classList.toggle('bg-primary', on);
            b.classList.toggle('text-black', on);
            b.classList.toggle('text-slate-200', !on);
            b.addEventListener('click', () => { if (b.dataset.lang !== lang) I18N.setLang(b.dataset.lang); });
        });
    }

    // ---- ?i18n=debug: list what is not translated yet ---------------------------------------------------------------
    // only text that is written in index.html / script.js counts as "untranslated" (station names, species names and
    // free-text comments from the data are not UI text)
    let sourceText = null;
    const sourcesReady = Promise.all(['index.html', 'script.js'].map(f => fetch(f, { cache: 'no-cache' }).then(r => r.text()).catch(() => '')))
        .then(parts => { sourceText = parts.join('\n'); });
    function uiMissing() {
        const all = [...missing.keys()];
        if (sourceText === null) return all;
        return all.filter(g => g.split(/\{n\}/).map(c => c.trim()).filter(c => c.length >= 3).every(c => sourceText.includes(c)));
    }
    I18N.missing = () => uiMissing();

    function debugButton() {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-no-i18n', '');
        b.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;background:#FEA11B;color:#000;font:600 12px sans-serif;padding:6px 10px;border-radius:6px;border:0;cursor:pointer';
        const upd = () => { b.textContent = `Untranslated (${uiMissing().length}) – click to download`; };
        upd();
        setInterval(upd, 1000);
        b.addEventListener('click', () => {
            const lines = uiMissing().sort().map(k => `    ${JSON.stringify(k.replace(/\{n\}/g, '{n:d}'))}: "",`);
            const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'untranslated.txt';
            a.click();
            console.log(lines.join('\n'));
        });
        document.body.appendChild(b);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
