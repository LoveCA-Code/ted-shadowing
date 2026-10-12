'use strict';

/* =========================================================
   TED Shadowing — 구간 반복 따라하기 + 단어장(SRS)
   ========================================================= */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const DAY = 86400000;

/* ---------------- 저장소 ---------------- */
const KEY = 'shadowing.v1';
const DEFAULT_SETTINGS = { reps: 2, gap: 1.2, rate: 1, autoNext: true, hideEn: false, showKo: false };
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
  return (store.progress[id] ||= { done: [], last: 0 });
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
  app.innerHTML = '<h1>TED Shadowing</h1><p class="sub">문장 단위로 듣고, 따라 말하고, 내 것으로.</p><div id="list"></div>';
  let talks = [];
  try {
    const r = await fetch('talks/index.json', { cache: 'no-cache' });
    if (r.ok) talks = await r.json();
  } catch {}
  const list = $('#list');
  if (!talks.length) {
    list.innerHTML = `<div class="empty">아직 강연이 없습니다.<br><br>PC에서 실행:<br><code>python tools/add_talk.py &lt;유튜브 주소&gt;</code></div>`;
    return;
  }
  list.innerHTML = talks.map((t) => {
    const p = store.progress[t.id];
    const done = p?.done.length || 0;
    const pct = Math.round((done / t.count) * 100);
    return `<a class="talk-item card" href="#/talk/${encodeURIComponent(t.id)}">
      <img src="https://i.ytimg.com/vi/${esc(t.id)}/mqdefault.jpg" alt="" loading="lazy">
      <div class="meta">
        <div class="t">${esc(t.title)}</div>
        <div class="s">${fmtTime(t.duration)} · ${t.count}문장 · 외운 문장 ${done}${p ? ` · ${p.last + 1}번째부터` : ''}</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div></a>`;
  }).join('');
}

/* =========================================================
   강연 — 구간 반복 플레이어
   ========================================================= */
async function viewTalk(id) {
  document.body.classList.add('in-talk');
  app.innerHTML = '<div class="empty">불러오는 중…</div>';
  const r = await fetch(`talks/${encodeURIComponent(id)}.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error('강연 파일을 찾을 수 없습니다: ' + id);
  const talk = await r.json();
  const segs = talk.segments;
  const S = store.settings;
  const prog = progressOf(id);
  const doneSet = new Set(prog.done);

  const st = {
    idx: Math.min(prog.last || 0, segs.length - 1),
    mode: 'idle', // idle | seg | gap | free
    repsDone: 0,
    gapStart: 0, gapEnd: 0,
    player: null, timer: 0, wake: null, alive: true,
  };

  const savedSingles = () => new Set(store.cards.map((c) => norm(c.text)).filter((t) => !t.includes(' ')));
  const savedRanges = (i) => store.cards.filter((c) => c.talkId === id && c.seg === i && c.range).map((c) => c.range);

  function rowHtml(seg, i) {
    const singles = savedSingles();
    const ranges = savedRanges(i);
    const en = tokenize(seg.text).map((p) => {
      if (!p.w) return esc(p.t);
      const saved = singles.has(norm(p.t)) || ranges.some(([a, b]) => p.i >= a && p.i <= b);
      return `<span class="w${saved ? ' saved' : ''}" data-w="${p.i}">${esc(p.t)}</span>`;
    }).join('');
    return `<div class="seg${doneSet.has(i) ? ' done' : ''}" data-i="${i}">
      <button class="num" data-play="${i}" aria-label="${i + 1}번 구간 재생">${doneSet.has(i) ? '✓' : i + 1}</button>
      <div class="body"><div class="en">${en}</div>${seg.ko ? `<div class="ko">${esc(seg.ko)}</div>` : ''}</div>
    </div>`;
  }

  app.innerHTML = `
    <div class="player-wrap">
      <div class="player-head">
        <button class="back" aria-label="뒤로">‹</button>
        <div class="title">${esc(talk.title)}</div>
      </div>
      <div class="player-box"><div id="yt"></div></div>
    </div>
    <div class="segments">${segs.map(rowHtml).join('')}</div>
    <div class="controls"><div class="inner">
      <div class="gap-bar"><i></i></div>
      <div class="status"></div>
      <div class="main-btns">
        <button data-act="prev" aria-label="이전 구간">⏮</button>
        <button data-act="replay" aria-label="현재 구간 다시">↺</button>
        <button data-act="play" class="play" aria-label="재생/정지">▶</button>
        <button data-act="next" aria-label="다음 구간">⏭</button>
        <button data-act="done" aria-label="외움 표시">✓<small>외움</small></button>
      </div>
      <div class="chips">
        <button class="chip" data-set="reps"></button>
        <button class="chip" data-set="gap"></button>
        <button class="chip" data-set="rate"></button>
        <button class="chip" data-set="autoNext"></button>
        <button class="chip" data-set="hideEn"></button>
        <button class="chip" data-set="showKo"></button>
      </div>
    </div></div>`;

  const segsEl = $('.segments');
  const statusEl = $('.status');
  const gapBar = $('.gap-bar i');
  const playBtn = $('[data-act="play"]');
  const rowEl = (i) => segsEl.children[i];

  /* --- 설정 칩 --- */
  const OPTS = {
    reps: { vals: [1, 2, 3, 5, 0], label: (v) => `반복 <b>${v === 0 ? '∞' : v + '회'}</b>` },
    gap: { vals: [0, 1, 1.2, 1.5, 2], label: (v) => `따라할 시간 <b>${v === 0 ? '없음' : '×' + v}</b>` },
    rate: { vals: [0.75, 0.85, 1, 1.15], label: (v) => `속도 <b>${v}x</b>` },
    autoNext: { vals: [true, false], label: (v) => `다음 구간 <b>${v ? '자동' : '멈춤'}</b>` },
    hideEn: { vals: [false, true], label: (v) => `영어 <b>${v ? '가림' : '보임'}</b>` },
    showKo: { vals: [false, true], label: (v) => `해석 <b>${v ? '보임' : '숨김'}</b>` },
  };
  function renderChips() {
    $$('.chip').forEach((c) => {
      const k = c.dataset.set;
      c.innerHTML = OPTS[k].label(S[k]);
      c.classList.toggle('on', (k === 'hideEn' || k === 'showKo') && S[k]);
    });
    document.body.classList.toggle('hide-en', S.hideEn);
    document.body.classList.toggle('show-ko', S.showKo);
  }
  renderChips();
  $('.chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    const k = c.dataset.set;
    const vals = OPTS[k].vals;
    S[k] = vals[(vals.indexOf(S[k]) + 1) % vals.length];
    if (k === 'rate') st.player?.setPlaybackRate(S.rate);
    renderChips();
    renderStatus();
    save();
  });

  /* --- 상태 표시 --- */
  function renderStatus(text) {
    statusEl.classList.toggle('say', st.mode === 'gap');
    if (text) statusEl.textContent = text;
    else if (st.mode === 'gap') statusEl.textContent = '🗣 따라 말해보세요';
    else if (st.mode === 'seg') statusEl.textContent = `${st.idx + 1} / ${segs.length} · ${st.repsDone + 1}${S.reps ? '/' + S.reps : ''}회째`;
    else if (st.mode === 'free') statusEl.textContent = `연속 재생 중 · ${st.idx + 1} / ${segs.length}`;
    else statusEl.textContent = `${st.idx + 1} / ${segs.length} · 외운 문장 ${doneSet.size}`;
    playBtn.textContent = st.mode === 'idle' ? '▶' : '⏸';
    if (st.mode !== 'gap') gapBar.style.width = '0';
  }

  function setCurrent(i, scroll = true) {
    rowEl(st.idx)?.classList.remove('current');
    st.idx = i;
    const row = rowEl(i);
    row.classList.add('current');
    prog.last = i;
    save();
    if (scroll) scrollToRow(row);
  }
  function scrollToRow(row) {
    const top = $('.player-wrap').getBoundingClientRect().bottom;
    const bottom = $('.controls').getBoundingClientRect().top;
    const r = row.getBoundingClientRect();
    if (r.top < top + 8 || r.bottom > bottom - 8) {
      window.scrollBy({ top: r.top - top - (bottom - top) * 0.25, behavior: 'smooth' });
    }
  }

  /* --- 재생 엔진 --- */
  function playSegment(i, resetReps = true) {
    if (!st.player || i < 0 || i >= segs.length) return;
    if (resetReps) st.repsDone = 0;
    setCurrent(i);
    st.mode = 'seg';
    st.player.setPlaybackRate(S.rate);
    st.player.seekTo(Math.max(0, segs[i].start - 0.05), true);
    st.player.playVideo();
    renderStatus();
  }
  function stop() {
    st.mode = 'idle';
    st.player?.pauseVideo();
    renderStatus();
  }
  function onSegmentEnd() {
    st.player.pauseVideo();
    st.repsDone++;
    const seg = segs[st.idx];
    if (S.gap > 0) {
      const ms = ((seg.end - seg.start) / S.rate) * S.gap * 1000 + 600;
      st.mode = 'gap';
      st.gapStart = performance.now();
      st.gapEnd = st.gapStart + ms;
      renderStatus();
    } else afterGap();
  }
  function afterGap() {
    if (S.reps === 0 || st.repsDone < S.reps) return playSegment(st.idx, false);
    if (S.autoNext && st.idx < segs.length - 1) return playSegment(st.idx + 1);
    st.mode = 'idle';
    renderStatus(st.idx >= segs.length - 1 ? '🎉 마지막 구간입니다' : undefined);
  }
  function segAt(t) {
    let lo = 0, hi = segs.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  function tick() {
    if (!st.player || !st.alive) return;
    if (st.mode === 'seg') {
      const seg = segs[st.idx];
      const next = segs[st.idx + 1];
      const tail = next ? Math.min(0.2, Math.max(0, next.start - seg.end)) : 0.3;
      if (st.player.getCurrentTime() >= seg.end + tail) onSegmentEnd();
    } else if (st.mode === 'gap') {
      const now = performance.now();
      gapBar.style.width = `${Math.min(100, ((now - st.gapStart) / (st.gapEnd - st.gapStart)) * 100)}%`;
      if (now >= st.gapEnd) afterGap();
    } else if (st.mode === 'free') {
      const i = segAt(st.player.getCurrentTime());
      if (i !== st.idx) { setCurrent(i); renderStatus(); }
    }
  }

  function onState(s) {
    // 유튜브 화면을 직접 눌러 재생/정지한 경우 → 연속 재생 모드로
    if (s === YS.PLAYING && (st.mode === 'idle' || st.mode === 'gap')) { st.mode = 'free'; renderStatus(); }
    else if ((s === YS.PAUSED || s === YS.ENDED) && st.mode === 'free') { st.mode = 'idle'; renderStatus(); }
  }

  /* --- 조작 --- */
  $('.back').addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#/')));
  $('.main-btns').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !st.player) return;
    const act = b.dataset.act;
    if (act === 'play') {
      if (st.mode === 'idle') { playSegment(st.idx); watchFirstPlay(st.player); } else stop();
    } else if (act === 'replay') playSegment(st.idx);
    else if (act === 'prev') playSegment(Math.max(0, st.idx - 1));
    else if (act === 'next') playSegment(Math.min(segs.length - 1, st.idx + 1));
    else if (act === 'done') {
      const i = st.idx;
      if (doneSet.has(i)) doneSet.delete(i); else doneSet.add(i);
      prog.done = [...doneSet].sort((a, b) => a - b);
      save();
      const row = rowEl(i);
      row.classList.toggle('done', doneSet.has(i));
      $('.num', row).textContent = doneSet.has(i) ? '✓' : i + 1;
      toast(doneSet.has(i) ? `${i + 1}번 문장 외움 ✓` : '외움 표시 해제');
      renderStatus();
    }
  });

  segsEl.addEventListener('click', (e) => {
    const playB = e.target.closest('[data-play]');
    if (playB) { playSegment(+playB.dataset.play); watchFirstPlay(st.player); return; }
    const row = e.target.closest('.seg');
    if (!row) return;
    const i = +row.dataset.i;
    if (S.hideEn && !row.classList.contains('peek')) { row.classList.add('peek'); return; }
    const w = e.target.closest('.w');
    if (w) openWordSheet(i, +w.dataset.w);
  });

  /* --- 단어 시트 --- */
  function openWordSheet(segIdx, wIdx) {
    const seg = segs[segIdx];
    const words = wordsOf(seg.text);
    let a = wIdx, b = wIdx;
    const termOf = () => {
      let t = words.slice(a, b + 1).join(' ');
      if (a === b && t !== 'I' && !/^[A-Z]{2,}$/.test(t)) t = t.toLowerCase();
      return t.replace(/’/g, "'");
    };
    const wasPlaying = st.mode !== 'idle';
    if (wasPlaying) stop();

    function draw() {
      const term = termOf();
      const existing = findCard(term);
      const sh = openSheet(`
        <div class="row" style="justify-content:space-between">
          <div><div class="word">${esc(term)}</div><div class="ipa" id="ipa"></div></div>
          <button class="btn small" id="say">🔊 발음</button>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn small" id="ext-l" ${a === 0 ? 'disabled' : ''}>◀ 앞 단어 포함</button>
          <button class="btn small" id="ext-r" ${b >= words.length - 1 ? 'disabled' : ''}>뒷 단어 포함 ▶</button>
          ${a !== b ? '<button class="btn small" id="ext-reset">한 단어로</button>' : ''}
        </div>
        <div class="ctx">${highlightCtx(seg.text, [a, b])}</div>
        <label>뜻 / 메모</label>
        <textarea id="meaning" placeholder="예) 깜짝 놀라다, 감탄하다">${esc(existing?.meaning || '')}</textarea>
        <div class="row" style="margin-top:6px">
          <a class="btn small" target="_blank" rel="noopener" href="https://en.dict.naver.com/#/search?query=${encodeURIComponent(term)}">네이버 사전</a>
          <a class="btn small" target="_blank" rel="noopener" href="https://www.google.com/search?q=${encodeURIComponent(term + ' meaning')}">구글 검색</a>
          <button class="btn small" id="clip">▶ 이 구간 듣기</button>
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
          : '사전 결과가 없습니다 (구/숙어는 네이버 사전을 이용하세요)';
      });

      $('#say').onclick = () => speak(term);
      $('#ext-l').onclick = () => { a--; draw(); };
      $('#ext-r').onclick = () => { b++; draw(); };
      if ($('#ext-reset')) $('#ext-reset').onclick = () => { a = b = wIdx; draw(); };
      $('#clip').onclick = () => { closeSheet(); playSegment(segIdx); };
      if ($('#cancel')) $('#cancel').onclick = closeSheet;
      if ($('#del')) $('#del').onclick = () => {
        store.cards = store.cards.filter((c) => c !== existing);
        save(); closeSheet(); refreshRow(existing.talkId === id ? existing.seg : segIdx); refreshAllSingles();
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
            ctx: seg.text, ko: seg.ko || '', range: [a, b],
            talkId: id, title: talk.title, seg: segIdx, start: seg.start, end: seg.end,
            created: Date.now(), due: Date.now(), ivl: 0, ease: 2.5, reps: 0, lapses: 0,
          });
        }
        save(); closeSheet();
        a === b ? refreshAllSingles() : refreshRow(segIdx);
        toast(existing ? '수정했습니다' : `"${term}" 저장 ✓`);
      };
    }
    draw();
  }
  function refreshRow(i) {
    const old = rowEl(i);
    const tmp = document.createElement('div');
    tmp.innerHTML = rowHtml(segs[i], i);
    const row = tmp.firstElementChild;
    row.className = old.className;
    old.replaceWith(row);
  }
  function refreshAllSingles() {
    const singles = savedSingles();
    $$('.w', segsEl).forEach((w) => {
      const i = +w.closest('.seg').dataset.i;
      const inRange = savedRanges(i).some(([a, b]) => +w.dataset.w >= a && +w.dataset.w <= b);
      w.classList.toggle('saved', singles.has(norm(w.textContent)) || inRange);
    });
  }

  /* --- 초기화 --- */
  const startAt = +(new URLSearchParams(location.hash.split('?')[1] || '').get('s') ?? NaN);
  if (!Number.isNaN(startAt) && startAt >= 0 && startAt < segs.length) st.idx = startAt;
  setCurrent(st.idx, false);
  renderStatus('플레이어 준비 중…');
  requestAnimationFrame(() => scrollToRow(rowEl(st.idx)));

  try { st.wake = await navigator.wakeLock?.request('screen'); } catch {}

  cleanup = () => {
    st.alive = false;
    clearInterval(st.timer);
    try { st.player?.destroy(); } catch {}
    st.wake?.release?.().catch(() => {});
  };

  st.player = await makePlayer($('#yt'), id, { onState, vars: { start: Math.floor(segs[st.idx].start) } });
  if (!st.alive) { try { st.player.destroy(); } catch {} return; }
  st.player.setPlaybackRate(S.rate);
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
      </div>`).join('') : `<div class="empty">${cards.length ? '검색 결과가 없습니다' : '강연 화면에서 단어를 탭하면 여기에 모입니다'}</div>`;
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
      <button class="btn small" id="say">🔊 발음</button>
    </div>
    <div class="ctx">${highlightCtx(c.ctx, c.range)}${c.ko ? `<div style="color:var(--muted);font-size:13px;margin-top:6px">${esc(c.ko)}</div>` : ''}</div>
    <label>뜻 / 메모</label>
    <textarea id="meaning">${esc(c.meaning || '')}</textarea>
    ${c.def ? `<label>영영 사전</label><div class="defs">${esc(c.def).replace(/\n/g, '<br>')}</div>` : ''}
    <div class="row" style="margin-top:12px">
      <a class="btn small" href="#/talk/${encodeURIComponent(c.talkId)}?s=${c.seg}">▶ 강연에서 보기</a>
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
      cur.done = [...new Set([...cur.done, ...(p.done || [])])].sort((a, b) => a - b);
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
        store.cards.length ? `다음 복습: ${fmtIvl(upcoming - Date.now())} 후` : '강연에서 단어를 탭해 모아보세요.'}</div>`;
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
          <button class="btn small" id="say">🔊 발음</button>
          <div class="ctx">${highlightCtx(c.ctx, c.range)}</div>
        </div>
        <div class="back" hidden>
          <div class="meaning">${esc(c.meaning || '(뜻을 적지 않았습니다)')}</div>
          ${c.phon ? `<div style="text-align:center;color:var(--muted)">${esc(c.phon)}</div>` : ''}
          ${c.def ? `<div class="defs">${esc(c.def).replace(/\n/g, '<br>')}</div>` : ''}
          ${c.ko ? `<div class="defs">💬 ${esc(c.ko)}</div>` : ''}
          <div class="row" style="margin-top:12px;justify-content:center">
            <button class="btn small" id="clip">▶ 원문 듣기</button>
            <button class="btn small" id="edit">✎ 수정</button>
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
