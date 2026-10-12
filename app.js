'use strict';

/* =========================================================
   TED Shadowing — 구간 반복 따라하기 + 단어장(SRS)
   ========================================================= */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const ICONS = {
  prev: '<path d="M19 20 9 12l10-8v16Z"/><path d="M5 19V5"/>',
  next: '<path d="m5 4 10 8-10 8V4Z"/><path d="M19 5v14"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  sound: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const DAY = 86400000;

/* ---------------- 저장소 ---------------- */
const KEY = 'shadowing.v1';
const DEFAULT_SETTINGS = { unit: 's1', rate: 1, hideEn: false, showKo: false };
const store = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
  return {
    cards: s.cards || [],
    progress: s.progress || {},
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
  };
})();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(store)); }
  catch { toast('저장 공간이 부족합니다. 백업을 내보내 주세요.'); }
  updateBadge();
}
navigator.storage?.persist?.().catch(() => {});

function progressOf(id) {
  return (store.progress[id] ||= { last: 0 });
}

/* ---------------- 공통 UI ---------------- */
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function openSheet(html) {
  const sh = $('#sheet');
  sh.innerHTML = '<div class="grab"></div>' + html;
  sh.hidden = false;
  $('#sheet-backdrop').hidden = false;
  sh.scrollTop = 0;
  return sh;
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
}
$('#sheet-backdrop').addEventListener('click', closeSheet);

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
function fmtIvl(ms) {
  const m = ms / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))}분`;
  if (m < 1380) return `${Math.round(m / 60)}시간`;
  const d = m / 1440;
  if (d < 30) return `${Math.round(d)}일`;
  if (d < 365) return `${Math.round(d / 30)}개월`;
  return `${(d / 365).toFixed(1)}년`;
}

/* ---------------- YouTube ---------------- */
let ytApi;
function loadYT() {
  return (ytApi ||= new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.append(s);
  }));
}
async function makePlayer(el, videoId, { onState, vars = {} } = {}) {
  const YT = await loadYT();
  const playerVars = { playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3, cc_load_policy: 0, ...vars };
  if (location.protocol.startsWith('http')) playerVars.origin = location.origin;
  return new Promise((resolve) => {
    const p = new YT.Player(el, {
      videoId, width: '100%', height: '100%', playerVars,
      events: { onReady: () => resolve(p), onStateChange: (e) => onState?.(e.data) },
    });
  });
}
const YS = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

/* 아이폰에서는 첫 재생이 막히는 경우가 있어 안내 */
function watchFirstPlay(player) {
  setTimeout(() => {
    try {
      const st = player.getPlayerState();
      if (st !== YS.PLAYING && st !== YS.BUFFERING && st !== YS.PAUSED) toast('재생이 안 되면 영상을 한 번 직접 탭해 주세요', 3500);
    } catch {}
  }, 1800);
}

/* ---------------- 단어 토큰화 ---------------- */
const WORD_RE = /[A-Za-z0-9][A-Za-z0-9'’\-]*/g;
function tokenize(text) {
  const parts = [];
  let last = 0, m;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(text))) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index) });
    parts.push({ t: m[0], w: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: text.slice(last) });
  let i = 0;
  for (const p of parts) if (p.w) p.i = i++;
  return parts;
}
function wordsOf(text) { return text.match(WORD_RE) || []; }
const norm = (s) => s.toLowerCase().replace(/’/g, "'").trim();

function highlightCtx(ctx, range) {
  if (!range) return esc(ctx);
  return tokenize(ctx).map((p) => (p.w && p.i >= range[0] && p.i <= range[1] ? `<mark>${esc(p.t)}</mark>` : esc(p.t))).join('')
    .replace(/<\/mark>(\s+)<mark>/g, '$1');
}

/* ---------------- 사전 ---------------- */
const dictCache = new Map();
async function lookup(term) {
  const key = norm(term);
  if (dictCache.has(key)) return dictCache.get(key);
  const getJSON = (url) => fetch(url, { signal: AbortSignal.timeout?.(7000) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const strip = (html) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent.trim();
  };
  // 뜻: 위키낱말사전(구/숙어도 지원), 발음기호: dictionaryapi.dev
  const [wk, da] = await Promise.all([
    getJSON('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(key.replace(/ /g, '_'))),
    getJSON('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(key)),
  ]);
  const defs = [];
  for (const e of wk?.en || []) {
    for (const d of e.definitions || []) {
      const def = strip(d.definition || '');
      if (def && defs.length < 4) { defs.push({ pos: e.partOfSpeech.toLowerCase(), def }); break; }
    }
  }
  if (!defs.length && Array.isArray(da)) {
    for (const m of da.flatMap((d) => d.meanings).slice(0, 4)) defs.push({ pos: m.partOfSpeech, def: m.definitions[0]?.definition || '' });
  }
  const phon = Array.isArray(da) ? da[0].phonetic || da[0].phonetics?.find((p) => p.text)?.text || '' : '';
  const out = defs.length || phon ? { phon, defs } : null;
  if (out) dictCache.set(key, out);
  return out;
}

/* ---------------- 간격 반복(SRS, SM-2 단순화) ---------------- */
function schedule(c, g, now = Date.now()) {
  // g: 0 다시, 1 어려움, 2 알맞음, 3 쉬움
  let { ivl = 0, ease = 2.5, reps = 0, lapses = 0 } = c;
  let due;
  if (g === 0) { ease = Math.max(1.3, ease - 0.2); lapses += ivl > 0 ? 1 : 0; ivl = 0; reps = 0; due = now + 60e3; }
  else if (g === 1) {
    ease = Math.max(1.3, ease - 0.15);
    if (ivl < 1) due = now + 10 * 60e3;
    else { ivl = Math.max(1, Math.round(ivl * 1.2)); due = now + ivl * DAY; }
    reps++;
  } else if (g === 2) {
    ivl = ivl < 1 ? 1 : ivl < 3 ? 3 : Math.round(ivl * ease);
    due = now + ivl * DAY; reps++;
  } else {
    ease += 0.15;
    ivl = ivl < 1 ? 4 : Math.round(ivl * ease * 1.3);
    due = now + ivl * DAY; reps++;
  }
  return { ivl, ease, reps, lapses, due };
}
function dueCards(ahead = 0) {
  const t = Date.now() + ahead;
  return store.cards.filter((c) => c.due <= t).sort((a, b) => a.due - b.due);
}
function updateBadge() {
  const n = dueCards().length;
  const b = $('#due-badge');
  b.hidden = n === 0;
  b.textContent = n > 99 ? '99+' : n;
}
function findCard(text) {
  const k = norm(text);
  return store.cards.find((c) => norm(c.text) === k);
}

/* ---------------- 라우터 ---------------- */
let cleanup = null;
async function route() {
  cleanup?.();
  cleanup = null;
  closeSheet();
  document.body.className = '';
  const [, view, arg] = (location.hash.slice(1).split('?')[0] || '/').split('/');
  $$('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (view || 'library')));
  window.scrollTo(0, 0);
  try {
    if (view === 'talk') await viewTalk(decodeURIComponent(arg));
    else if (view === 'vocab') viewVocab();
    else if (view === 'review') viewReview();
    else await viewLibrary();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="empty">불러오지 못했습니다.<br><small>${esc(e.message)}</small></div>`;
  }
}
window.addEventListener('hashchange', route);

/* =========================================================
   강연 목록
   ========================================================= */
async function viewLibrary() {
  app.innerHTML = '<h1>TED Shadowing</h1><p class="sub">구간을 듣고, 멈추고, 따라 말하기.</p><div class="chips cat-chips" id="cats"></div><div id="list"></div>';
  let talks = [];
  try {
    const r = await fetch('talks/index.json', { cache: 'no-cache' });
    if (r.ok) talks = await r.json();
  } catch {}
  const list = $('#list');
  if (!talks.length) {
    list.innerHTML = `<div class="empty">아직 강연이 없습니다.<br><br>PC에서 실행:<br><code>python tools/add_talk.py &lt;유튜브 주소&gt; -c 카테고리</code></div>`;
    return;
  }
  const cats = [...new Set(talks.map((t) => t.category || '기타'))];
  let cur = store.settings.libCat && cats.includes(store.settings.libCat) ? store.settings.libCat : '전체';

  const draw = () => {
    $('#cats').innerHTML = ['전체', ...cats].map((c) => `<button class="chip${c === cur ? ' on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
    const shown = cats.filter((c) => cur === '전체' || c === cur);
    list.innerHTML = shown.map((c) => `
      <h2>${esc(c)}</h2>
      ${talks.filter((t) => (t.category || '기타') === c).map((t) => {
        const p = store.progress[t.id];
        const pct = p ? Math.round(((p.last + 1) / t.sentences) * 100) : 0;
        return `<a class="talk-item card" href="#/talk/${encodeURIComponent(t.id)}">
          <img src="https://i.ytimg.com/vi/${esc(t.id)}/mqdefault.jpg" alt="" loading="lazy">
          <div class="meta">
            <div class="t">${esc(t.title)}</div>
            <div class="s">${fmtTime(t.duration)} · 섹션 ${t.sections} · 문단 ${t.paragraphs} · 문장 ${t.sentences}</div>
            <div class="bar"><i style="width:${pct}%"></i></div>
          </div></a>`;
      }).join('')}`).join('');
  };
  draw();
  $('#cats').addEventListener('click', (e) => {
    const c = e.target.closest('[data-c]');
    if (!c) return;
    cur = c.dataset.c;
    store.settings.libCat = cur;
    save();
    draw();
  });
}

/* =========================================================
   강연 — 구간 재생 (누를 때마다 처음부터, 끝나면 멈춤)
   ========================================================= */
const UNITS = [
  { k: 's1', label: '1문장', group: '문장' }, { k: 's2', label: '2문장' }, { k: 's3', label: '3문장' }, { k: 's4', label: '4문장' },
  { k: 'p4', label: '¼문단', group: '문단' }, { k: 'p3', label: '⅓문단' }, { k: 'p2', label: '½문단' }, { k: 'p1', label: '1문단' },
  { k: 'sec', label: '섹션', group: '' },
];

/* 문장/문단/섹션 경계로부터 재생 묶음 [a, b) 목록을 만든다 */
function buildGroups(talk, unit) {
  const S = talk.sentences;
  const P = [...talk.paragraphs, S.length];
  const X = [...talk.sections, talk.paragraphs.length];
  const groups = [];
  const secOfPara = [];
  for (let x = 0; x < X.length - 1; x++) for (let p = X[x]; p < X[x + 1]; p++) secOfPara[p] = x;

  if (unit === 'sec') {
    for (let x = 0; x < X.length - 1; x++) groups.push({ a: P[X[x]], b: P[X[x + 1]], sec: x, para: X[x] });
    return groups;
  }
  for (let p = 0; p < P.length - 1; p++) {
    const pa = P[p], pb = P[p + 1];
    const base = { sec: secOfPara[p], para: p };
    if (unit[0] === 's') {
      const n = +unit.slice(1);
      for (let a = pa; a < pb; a += n) groups.push({ ...base, a, b: Math.min(pb, a + n) });
    } else {
      // 문단을 k 등분: 시간 길이가 고르게 되도록 문장 경계에서 자름
      const k = Math.min(+unit.slice(1), pb - pa);
      const t0 = S[pa].s, total = S[pb - 1].e - t0;
      const cuts = [pa];
      for (let j = 1; j < k; j++) {
        const target = t0 + (total * j) / k;
        let best = null;
        for (let i = cuts[cuts.length - 1] + 1; i <= pb - (k - j); i++) {
          if (best === null || Math.abs(S[i].s - target) < Math.abs(S[best].s - target)) best = i;
        }
        cuts.push(best);
      }
      cuts.push(pb);
      for (let j = 0; j < cuts.length - 1; j++) groups.push({ ...base, a: cuts[j], b: cuts[j + 1] });
    }
  }
  return groups;
}

async function viewTalk(id) {
  document.body.classList.add('in-talk');
  app.innerHTML = '<div class="empty">불러오는 중…</div>';
  const r = await fetch(`talks/${encodeURIComponent(id)}.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error('강연 파일을 찾을 수 없습니다: ' + id);
  const talk = await r.json();
  const S = talk.sentences;
  const set = store.settings;
  if (!UNITS.some((u) => u.k === set.unit)) set.unit = 's1';
  const prog = progressOf(id);

  const st = {
    groups: [], g: 0,
    mode: 'idle', // idle | seg | free
    stopAt: 0, speaking: -1,
    player: null, timer: 0, wake: null, alive: true,
  };

  const savedSingles = () => new Set(store.cards.map((c) => norm(c.text)).filter((t) => !t.includes(' ')));
  const savedRanges = (k) => store.cards.filter((c) => c.talkId === id && c.sent === k && c.range).map((c) => c.range);

  function sentHtml(k, singles) {
    const ranges = savedRanges(k);
    return `<span class="sent" data-s="${k}">${tokenize(S[k].t).map((p) => {
      if (!p.w) return esc(p.t);
      const saved = singles.has(norm(p.t)) || ranges.some(([a, b]) => p.i >= a && p.i <= b);
      return `<span class="w${saved ? ' saved' : ''}" data-w="${p.i}">${esc(p.t)}</span>`;
    }).join('')}</span>`;
  }
  const dur = (g) => S[g.b - 1].e - S[g.a].s;

  function groupHtml(g, i, singles) {
    const ko = S.slice(g.a, g.b).map((s) => s.ko).filter(Boolean).join(' ');
    const head = i === 0 || st.groups[i - 1].sec !== g.sec
      ? `<div class="sec-head">섹션 ${g.sec + 1} <span>${fmtTime(S[g.a].s)}</span></div>` : '';
    const pstart = i > 0 && st.groups[i - 1].para !== g.para;
    return `${head}<div class="seg${pstart ? ' pstart' : ''}" data-g="${i}">
      <div class="num">${i + 1}</div>
      <div class="body">
        <div class="en">${Array.from({ length: g.b - g.a }, (_, j) => sentHtml(g.a + j, singles)).join(' ')}</div>
        ${ko ? `<div class="ko">${esc(ko)}</div>` : ''}
        <div class="len">${Math.round(dur(g))}초</div>
      </div>
    </div>`;
  }

  app.innerHTML = `
    <div class="player-wrap">
      <div class="player-head">
        <button class="back" aria-label="뒤로">${icon('back')}</button>
        <div class="title">${esc(talk.title)}</div>
      </div>
      <div class="player-box"><div id="yt"></div></div>
    </div>
    <div class="segments"></div>
    <div class="controls"><div class="inner">
      <div class="status"></div>
      <div class="main-btns">
        <button data-act="prev" aria-label="이전 구간">${icon('prev')}</button>
        <button data-act="play" class="play" aria-label="처음부터 재생">${icon('play', 'fill')}<span>처음부터 재생</span></button>
        <button data-act="stop" aria-label="정지">${icon('stop', 'fill')}</button>
        <button data-act="next" aria-label="다음 구간">${icon('next')}</button>
      </div>
      <div class="chips unit-chips">${UNITS.map((u) =>
        `${u.group !== undefined ? `<span class="chip-label">${u.group}</span>` : ''}<button class="chip" data-unit="${u.k}">${u.label}</button>`).join('')}</div>
      <div class="chips">
        <button class="chip" data-set="rate"></button>
        <button class="chip" data-set="hideEn"></button>
        <button class="chip" data-set="showKo"></button>
      </div>
    </div></div>`;

  const segsEl = $('.segments');
  const statusEl = $('.status');
  const rowEl = (i) => segsEl.querySelector(`.seg[data-g="${i}"]`);

  /* --- 묶음 단위 --- */
  function regroup() {
    const anchor = st.groups[st.g]?.a ?? Math.min(prog.last || 0, S.length - 1);
    st.groups = buildGroups(talk, set.unit);
    st.g = Math.max(0, st.groups.findIndex((g) => anchor >= g.a && anchor < g.b));
    const singles = savedSingles();
    segsEl.innerHTML = st.groups.map((g, i) => groupHtml(g, i, singles)).join('');
    $$('[data-unit]').forEach((c) => c.classList.toggle('on', c.dataset.unit === set.unit));
    setCurrent(st.g, false);
    requestAnimationFrame(() => scrollToRow(rowEl(st.g), true));
  }
  $('.unit-chips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-unit]');
    if (!c || c.dataset.unit === set.unit) return;
    if (st.mode === 'seg') stop();
    set.unit = c.dataset.unit;
    save();
    regroup();
    c.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  });

  /* --- 표시 설정 --- */
  const OPTS = {
    rate: { vals: [0.75, 0.85, 1, 1.15], label: (v) => `속도 <b>${v}x</b>` },
    hideEn: { vals: [false, true], label: (v) => `영어 <b>${v ? '가림' : '보임'}</b>` },
    showKo: { vals: [false, true], label: (v) => `해석 <b>${v ? '보임' : '숨김'}</b>` },
  };
  function renderChips() {
    $$('[data-set]').forEach((c) => {
      const k = c.dataset.set;
      c.innerHTML = OPTS[k].label(set[k]);
      c.classList.toggle('on', k !== 'rate' && set[k]);
    });
    document.body.classList.toggle('hide-en', set.hideEn);
    document.body.classList.toggle('show-ko', set.showKo);
  }
  $$('[data-set]').forEach((c) => c.addEventListener('click', () => {
    const k = c.dataset.set;
    const vals = OPTS[k].vals;
    set[k] = vals[(vals.indexOf(set[k]) + 1) % vals.length];
    if (k === 'rate') st.player?.setPlaybackRate(set.rate);
    if (k === 'hideEn') $$('.peek', segsEl).forEach((el) => el.classList.remove('peek'));
    renderChips();
    save();
  }));

  /* --- 상태 --- */
  function renderStatus(text) {
    const g = st.groups[st.g];
    statusEl.textContent = text || `${st.g + 1} / ${st.groups.length} · ${Math.round(dur(g))}초${st.mode === 'seg' ? ' · 재생 중' : st.mode === 'free' ? ' · 연속 재생' : ''}`;
  }
  function setCurrent(i, scroll = true) {
    rowEl(st.g)?.classList.remove('current');
    st.g = i;
    const row = rowEl(i);
    row?.classList.add('current');
    prog.last = st.groups[i].a;
    save();
    if (scroll) scrollToRow(row);
    renderStatus();
  }
  function scrollToRow(row, force = false) {
    if (!row) return;
    const top = $('.player-wrap').getBoundingClientRect().bottom;
    const bottom = $('.controls').getBoundingClientRect().top;
    const r = row.getBoundingClientRect();
    if (force || r.top < top + 8 || r.bottom > bottom - 8) {
      window.scrollBy({ top: r.top - top - 12, behavior: force ? 'auto' : 'smooth' });
    }
  }
  function markSpeaking(k) {
    if (k === st.speaking) return;
    segsEl.querySelector('.sent.speaking')?.classList.remove('speaking');
    st.speaking = k;
    if (k >= 0) segsEl.querySelector(`.sent[data-s="${k}"]`)?.classList.add('speaking');
  }

  /* --- 재생 --- */
  function play(i) {
    if (!st.player || i < 0 || i >= st.groups.length) return;
    setCurrent(i);
    const g = st.groups[i];
    const next = S[g.b];
    const tail = next ? Math.min(0.25, Math.max(0, next.s - S[g.b - 1].e)) : 0.4;
    st.stopAt = S[g.b - 1].e + tail;
    st.mode = 'seg';
    st.player.setPlaybackRate(set.rate);
    st.player.seekTo(Math.max(0, S[g.a].s - 0.05), true);
    st.player.playVideo();
    renderStatus();
    watchFirstPlay(st.player);
  }
  function stop() {
    st.mode = 'idle';
    st.player?.pauseVideo();
    markSpeaking(-1);
    renderStatus();
  }
  function sentAt(t) {
    let lo = 0, hi = S.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (S[mid].s <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  function tick() {
    if (!st.player || !st.alive || st.mode === 'idle') return;
    const t = st.player.getCurrentTime();
    const k = sentAt(t);
    if (st.mode === 'seg') {
      markSpeaking(k);
      if (t >= st.stopAt) stop();
    } else if (st.mode === 'free') {
      markSpeaking(k);
      const gi = st.groups.findIndex((g) => k >= g.a && k < g.b);
      if (gi >= 0 && gi !== st.g) setCurrent(gi);
    }
  }
  function onState(s) {
    // 유튜브 화면을 직접 눌러 재생하면 연속 재생 모드 (현재 구간이 따라감)
    if (s === YS.PLAYING && st.mode === 'idle') { st.mode = 'free'; renderStatus(); }
    else if ((s === YS.PAUSED || s === YS.ENDED) && st.mode === 'free') { st.mode = 'idle'; markSpeaking(-1); renderStatus(); }
  }

  /* --- 버튼 --- */
  $('.back').addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#/')));
  $('.main-btns').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !st.player) return;
    const act = b.dataset.act;
    if (act === 'play') play(st.g);
    else if (act === 'stop') stop();
    else if (act === 'prev') play(Math.max(0, st.g - 1));
    else if (act === 'next') play(Math.min(st.groups.length - 1, st.g + 1));
  });

  /* --- 탭 = 재생, 길게 누르기 = 단어 저장 --- */
  let press = null, suppressClick = false;
  segsEl.addEventListener('pointerdown', (e) => {
    const w = e.target.closest('.w');
    if (!w) return;
    press = { x: e.clientX, y: e.clientY, w, timer: setTimeout(() => {
      press = null;
      suppressClick = true;
      w.classList.add('sel');
      setTimeout(() => w.classList.remove('sel'), 400);
      const k = +w.closest('.sent').dataset.s;
      openWordSheet(k, +w.dataset.w);
    }, 480) };
  });
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  segsEl.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
  });
  segsEl.addEventListener('pointerup', cancelPress);
  segsEl.addEventListener('pointercancel', cancelPress);
  segsEl.addEventListener('contextmenu', (e) => e.preventDefault());
  segsEl.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const row = e.target.closest('.seg');
    if (!row) return;
    if (set.hideEn && !row.classList.contains('peek') && e.target.closest('.en')) { row.classList.add('peek'); return; }
    play(+row.dataset.g);
  });

  /* --- 단어 시트 --- */
  function openWordSheet(k, wIdx) {
    const sent = S[k];
    const words = wordsOf(sent.t);
    let a = wIdx, b = wIdx;
    const termOf = () => {
      let t = words.slice(a, b + 1).join(' ');
      if (a === b && t !== 'I' && !/^[A-Z]{2,}$/.test(t)) t = t.toLowerCase();
      return t.replace(/’/g, "'");
    };
    if (st.mode !== 'idle') stop();

    function draw() {
      const term = termOf();
      const existing = findCard(term);
      const sh = openSheet(`
        <div class="row" style="justify-content:space-between">
          <div><div class="word">${esc(term)}</div><div class="ipa" id="ipa"></div></div>
          <button class="btn small" id="say">${icon('sound')}발음</button>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn small" id="ext-l" ${a === 0 ? 'disabled' : ''}>◀ 앞 단어 포함</button>
          <button class="btn small" id="ext-r" ${b >= words.length - 1 ? 'disabled' : ''}>뒷 단어 포함 ▶</button>
          ${a !== b ? '<button class="btn small" id="ext-reset">한 단어로</button>' : ''}
        </div>
        <div class="ctx">${highlightCtx(sent.t, [a, b])}</div>
        <label>뜻 / 메모</label>
        <textarea id="meaning" placeholder="예) 깜짝 놀라다, 감탄하다">${esc(existing?.meaning || '')}</textarea>
        <div class="row" style="margin-top:6px">
          <a class="btn small" target="_blank" rel="noopener" href="https://en.dict.naver.com/#/search?query=${encodeURIComponent(term)}">네이버 사전</a>
          <a class="btn small" target="_blank" rel="noopener" href="https://www.google.com/search?q=${encodeURIComponent(term + ' meaning')}">구글 검색</a>
        </div>
        <label>영영 사전</label>
        <div class="defs" id="defs">찾는 중…</div>
        <div class="actions">
          ${existing ? '<button class="btn" id="del">삭제</button>' : '<button class="btn" id="cancel">닫기</button>'}
          <button class="btn primary" id="save">${existing ? '수정 저장' : '단어장에 저장'}</button>
        </div>`);

      let dict = null;
      lookup(term).then((d) => {
        dict = d;
        if (termOf() !== term || sh.hidden) return;
        $('#ipa').textContent = d?.phon || '';
        $('#defs').innerHTML = d?.defs.length
          ? d.defs.map((x) => `<p><em>${esc(x.pos)}</em>${esc(x.def)}</p>`).join('')
          : '사전 결과가 없습니다 (네이버 사전을 이용하세요)';
      });

      $('#say').onclick = () => speak(term);
      $('#ext-l').onclick = () => { a--; draw(); };
      $('#ext-r').onclick = () => { b++; draw(); };
      if ($('#ext-reset')) $('#ext-reset').onclick = () => { a = b = wIdx; draw(); };
      if ($('#cancel')) $('#cancel').onclick = closeSheet;
      if ($('#del')) $('#del').onclick = () => {
        store.cards = store.cards.filter((c) => c !== existing);
        save(); closeSheet(); refreshSaved();
        toast('삭제했습니다');
      };
      $('#save').onclick = () => {
        const meaning = $('#meaning').value.trim();
        const def = dict?.defs.slice(0, 2).map((x) => `(${x.pos}) ${x.def}`).join('\n') || '';
        if (existing) {
          Object.assign(existing, { meaning, def: existing.def || def, phon: existing.phon || dict?.phon || '' });
        } else {
          store.cards.push({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            text: term, meaning, def, phon: dict?.phon || '',
            ctx: sent.t, ko: sent.ko || '', range: [a, b],
            talkId: id, title: talk.title, sent: k, start: sent.s, end: sent.e,
            created: Date.now(), due: Date.now(), ivl: 0, ease: 2.5, reps: 0, lapses: 0,
          });
        }
        save(); closeSheet(); refreshSaved();
        toast(existing ? '수정했습니다' : `"${term}" 저장 ✓`);
      };
    }
    draw();
  }
  function refreshSaved() {
    const singles = savedSingles();
    $$('.w', segsEl).forEach((w) => {
      const k = +w.closest('.sent').dataset.s;
      const i = +w.dataset.w;
      w.classList.toggle('saved', singles.has(norm(w.textContent)) || savedRanges(k).some(([a, b]) => i >= a && i <= b));
    });
  }

  /* --- 초기화 --- */
  const startAt = +(new URLSearchParams(location.hash.split('?')[1] || '').get('s') ?? NaN);
  if (!Number.isNaN(startAt) && startAt >= 0 && startAt < S.length) prog.last = startAt;
  renderChips();
  regroup();
  renderStatus('플레이어 준비 중…');

  try { st.wake = await navigator.wakeLock?.request('screen'); } catch {}
  cleanup = () => {
    st.alive = false;
    clearInterval(st.timer);
    try { st.player?.destroy(); } catch {}
    st.wake?.release?.().catch(() => {});
  };

  st.player = await makePlayer($('#yt'), id, { onState, vars: { start: Math.floor(S[st.groups[st.g].a].s) } });
  if (!st.alive) { try { st.player.destroy(); } catch {} return; }
  st.player.setPlaybackRate(set.rate);
  st.timer = setInterval(tick, 50);
  renderStatus();
}

/* =========================================================
   단어장
   ========================================================= */
function viewVocab() {
  const now = Date.now();
  const cards = store.cards;
  const due = dueCards().length;
  const fresh = cards.filter((c) => c.reps === 0 && c.ivl === 0).length;
  app.innerHTML = `
    <h1>단어장</h1>
    <div class="stats">
      <div class="card"><b>${cards.length}</b><span>전체</span></div>
      <div class="card"><b>${due}</b><span>지금 복습</span></div>
      <div class="card"><b>${fresh}</b><span>새 단어</span></div>
    </div>
    ${due ? `<a class="btn primary" style="width:100%;margin-bottom:16px" href="#/review">복습 시작 (${due})</a>` : ''}
    <input class="search" type="search" placeholder="검색" id="q">
    <div id="vlist"></div>
    <h2>백업</h2>
    <p class="sub">단어장은 이 기기(브라우저)에만 저장됩니다. 가끔 백업 파일을 내보내 두세요.</p>
    <div class="row">
      <button class="btn" id="export">내보내기</button>
      <label class="btn" style="margin:0">가져오기<input type="file" id="import" accept=".json,application/json" hidden></label>
    </div>`;

  const draw = () => {
    const q = norm($('#q').value);
    const list = cards
      .filter((c) => !q || norm(c.text).includes(q) || (c.meaning || '').includes(q))
      .sort((a, b) => b.created - a.created);
    $('#vlist').innerHTML = list.length ? list.map((c) => `
      <div class="v-item card" data-id="${c.id}">
        <div class="main">
          <div class="t">${esc(c.text)}</div>
          ${c.meaning ? `<div class="m">${esc(c.meaning)}</div>` : ''}
          <div class="c">${highlightCtx(c.ctx, c.range)}</div>
        </div>
        <div class="due">${c.due <= now ? '복습 대기' : fmtIvl(c.due - now) + ' 후'}</div>
      </div>`).join('') : `<div class="empty">${cards.length ? '검색 결과가 없습니다' : '강연 화면에서 단어를 길게 누르면 여기에 모입니다'}</div>`;
  };
  draw();
  $('#q').addEventListener('input', draw);
  $('#vlist').addEventListener('click', (e) => {
    const it = e.target.closest('.v-item');
    if (it) editCard(store.cards.find((c) => c.id === it.dataset.id), draw);
  });
  $('#export').onclick = exportBackup;
  $('#import').onchange = (e) => importBackup(e.target.files[0]).then(() => viewVocab());
}

function editCard(c, onDone) {
  openSheet(`
    <div class="row" style="justify-content:space-between">
      <div><div class="word">${esc(c.text)}</div><div class="ipa">${esc(c.phon || '')}</div></div>
      <button class="btn small" id="say">${icon('sound')}발음</button>
    </div>
    <div class="ctx">${highlightCtx(c.ctx, c.range)}${c.ko ? `<div style="color:var(--muted);font-size:13px;margin-top:6px">${esc(c.ko)}</div>` : ''}</div>
    <label>뜻 / 메모</label>
    <textarea id="meaning">${esc(c.meaning || '')}</textarea>
    ${c.def ? `<label>영영 사전</label><div class="defs">${esc(c.def).replace(/\n/g, '<br>')}</div>` : ''}
    <div class="row" style="margin-top:12px">
      <a class="btn small" href="#/talk/${encodeURIComponent(c.talkId)}?s=${c.sent ?? 0}">▶ 강연에서 보기</a>
      <a class="btn small" target="_blank" rel="noopener" href="https://en.dict.naver.com/#/search?query=${encodeURIComponent(c.text)}">네이버 사전</a>
    </div>
    <div class="actions">
      <button class="btn" id="del">삭제</button>
      <button class="btn primary" id="save">저장</button>
    </div>`);
  $('#say').onclick = () => speak(c.text);
  $('#del').onclick = () => {
    if (!confirm(`"${c.text}"을(를) 삭제할까요?`)) return;
    store.cards = store.cards.filter((x) => x !== c);
    save(); closeSheet(); onDone?.();
    if (location.hash.startsWith('#/vocab')) viewVocab();
  };
  $('#save').onclick = () => { c.meaning = $('#meaning').value.trim(); save(); closeSheet(); onDone?.(); };
}

function exportBackup() {
  const data = JSON.stringify({ app: 'ted-shadowing', version: 1, exported: new Date().toISOString(), ...store }, null, 1);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `shadowing-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importBackup(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.cards)) throw new Error();
    const byId = new Map(store.cards.map((c) => [c.id, c]));
    for (const c of data.cards) byId.set(c.id, c);
    store.cards = [...byId.values()];
    for (const [k, p] of Object.entries(data.progress || {})) {
      const cur = progressOf(k);
      cur.last = p.last ?? cur.last;
    }
    save();
    toast(`가져오기 완료 · 단어 ${data.cards.length}개`);
  } catch { toast('백업 파일을 읽을 수 없습니다'); }
}

/* =========================================================
   복습 (안키 방식)
   ========================================================= */
function viewReview() {
  let player = null, playerVideo = null, clipEnd = 0, clipTimer = 0;
  cleanup = () => { clearInterval(clipTimer); try { player?.destroy(); } catch {} };

  function next() {
    clearInterval(clipTimer);
    try { player?.destroy(); } catch {}
    player = null; playerVideo = null;

    let queue = dueCards();
    if (!queue.length) queue = dueCards(20 * 60e3); // 방금 '다시' 누른 카드
    if (!queue.length) {
      const upcoming = store.cards.length ? Math.min(...store.cards.map((c) => c.due)) : 0;
      app.innerHTML = `<h1>복습</h1><div class="empty">🎉 지금 복습할 단어가 없습니다.<br>${
        store.cards.length ? `다음 복습: ${fmtIvl(upcoming - Date.now())} 후` : '강연에서 단어를 길게 눌러 모아보세요.'}</div>`;
      updateBadge();
      return;
    }
    const c = queue[0];
    const left = dueCards().length;
    app.innerHTML = `
      <h1>복습</h1><p class="sub">남은 카드 ${left || queue.length}장</p>
      <div class="card flash">
        <div class="front">
          <div class="term">${esc(c.text)}</div>
          <button class="btn small" id="say">${icon('sound')}발음</button>
          <div class="ctx">${highlightCtx(c.ctx, c.range)}</div>
        </div>
        <div class="back" hidden>
          <div class="meaning">${esc(c.meaning || '(뜻을 적지 않았습니다)')}</div>
          ${c.phon ? `<div style="text-align:center;color:var(--muted)">${esc(c.phon)}</div>` : ''}
          ${c.def ? `<div class="defs">${esc(c.def).replace(/\n/g, '<br>')}</div>` : ''}
          ${c.ko ? `<div class="defs">💬 ${esc(c.ko)}</div>` : ''}
          <div class="row" style="margin-top:12px;justify-content:center">
            <button class="btn small" id="clip">${icon('play', 'fill')}원문 듣기</button>
            <button class="btn small" id="edit">${icon('edit')}수정</button>
          </div>
          <div class="review-player" hidden><div class="player-box"><div id="rp"></div></div></div>
        </div>
        <div style="flex:1"></div>
        <button class="btn primary" id="show" style="margin-top:20px">정답 보기</button>
        <div class="grades" hidden>
          ${['다시', '어려움', '알맞음', '쉬움'].map((l, g) =>
            `<button data-g="${g}" class="${['again', '', 'good', ''][g]}">${l}<small>${fmtIvl(schedule(c, g).due - Date.now())}</small></button>`).join('')}
        </div>
      </div>`;
    $('#say').onclick = () => speak(c.text);
    $('#show').onclick = () => {
      $('.back').hidden = false; $('.grades').hidden = false; $('#show').hidden = true;
      speak(c.text);
    };
    $('#edit').onclick = () => editCard(c, next);
    $('#clip').onclick = async () => {
      $('.review-player').hidden = false;
      if (!player || playerVideo !== c.talkId) {
        player = await makePlayer($('#rp'), c.talkId, { vars: { start: Math.floor(c.start) } });
        playerVideo = c.talkId;
      }
      player.seekTo(Math.max(0, c.start - 0.05), true);
      player.playVideo();
      watchFirstPlay(player);
      clipEnd = c.end + 0.25;
      clearInterval(clipTimer);
      clipTimer = setInterval(() => {
        try { if (player.getCurrentTime() >= clipEnd) { player.pauseVideo(); clearInterval(clipTimer); } } catch {}
      }, 50);
    };
    $('.grades').onclick = (e) => {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      Object.assign(c, schedule(c, +b.dataset.g));
      save();
      next();
    };
  }
  next();
}

/* ---------------- 시작 ---------------- */
updateBadge();
route();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
