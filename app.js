// Shadowing — F2 구간 재생 + F3 구간 묶음
// 누르면 현재 구간을 처음부터 재생하고 구간 끝에서 멈춘다. 자동 반복·대기·자동 다음 없음.
// 구간 = 고른 단위(문장 / 약 5·10·20·30초 / 문단 / 섹션)로 묶은 연속 문장. 초 단위는 문단 안에서만 묶는다.
// 소리·영상은 TED 서버(HLS)에서 바로 재생. 문장 시간(s, e)은 그 스트림의 처음(인트로 포함)부터의 초.

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const video = $('video');
const list = $('list');

const STORE = 'shadowing.v2';
const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';  // 사파리가 아닌 브라우저(PC 확인용)
// 아이폰·사파리만 기본 재생기를 쓴다 (크롬은 '재생 가능'이라 답하고도 TED 스트림을 못 여는 경우가 있음)
const isApple = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (/Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|Android|Edg\//.test(navigator.userAgent));
const nativeHls = isApple && audio.canPlayType('application/vnd.apple.mpegurl') !== '';

const UNITS = [
  { id: 'sentence', label: '문장', big: true },
  { id: '5', label: '5초', sec: 5, big: true },
  { id: '10', label: '10초', sec: 10 },
  { id: '20', label: '20초', sec: 20 },
  { id: '30', label: '30초', sec: 30 },
  { id: 'paragraph', label: '문단' },
  { id: 'section', label: '섹션' },
];

let talk = null;
let S = [];
let chunks = [];        // [{a, b}] 문장 a부터 b-1까지
let ci = 0;             // 지금 구간 번호
let unit = UNITS[0];
let showKo = true;
let showVideo = false;
const RATES = [0.75, 0.85, 1];
let rate = 1;            // F5 재생 속도
let hideEn = false;      // F4 영어 가리기 (듣기 모드)
let peeking = false;    // 가린 구간을 누르고 있는 동안 영어를 보여 주는 중
let target = null;      // 지금 재생 중인 구간 {s, e, ci}
let stopTimer = 0;
const attached = new WeakMap();

// ---------- 저장 ----------
function load() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { return {}; }
}
function save() {
  try {
    const st = load();
    st.showKo = showKo;
    st.showVideo = showVideo;
    st.hideEn = hideEn;
    st.rate = rate;
    st.unit = unit.id;
    st.talk = talk && talk.id;
    // 위치는 구간 첫 문장 번호로 기억 (단위를 바꿔도 같은 곳에서 이어지게)
    st.pos = Object.assign(st.pos || {}, talk && chunks[ci] ? { [talk.id]: chunks[ci].a } : {});
    localStorage.setItem(STORE, JSON.stringify(st));
  } catch (e) {}
}

// ---------- 구간 묶기 ----------
const dur = (a, b) => S[b - 1].e - S[a].s;

function paragraphRanges() {
  const starts = talk.paragraphs;
  return starts.map((a, k) => ({ a, b: k + 1 < starts.length ? starts[k + 1] : S.length }));
}
function buildChunks() {
  if (unit.id === 'sentence') return S.map((_, i) => ({ a: i, b: i + 1 }));
  const paras = paragraphRanges();
  if (unit.id === 'paragraph') return paras;
  if (unit.id === 'section') {
    const starts = (talk.sections || []).map((x) => talk.paragraphs[x.p]).filter((a) => a !== undefined);
    if (!starts.length || starts[0] !== 0) starts.unshift(0);
    return starts.map((a, k) => ({ a, b: k + 1 < starts.length ? starts[k + 1] : S.length }));
  }
  // 초 단위: 문단 안에서 문장을 이어 붙여 목표 길이에 가깝게. 목표의 80%를 넘으면 닫고,
  // 다음 문장을 붙여 130%를 넘게 되면 거기서 닫는다. 한 문장이 목표보다 길면 그 문장 하나.
  const T = unit.sec;
  const out = [];
  for (const p of paras) {
    const local = [];
    let a = p.a;
    for (let j = p.a + 1; j <= p.b; j++) {
      const closeHere = j === p.b || dur(a, j) >= T * 0.8 || dur(a, j + 1) > T * 1.3;
      if (closeHere) { local.push({ a, b: j }); a = j; }
    }
    // 문단 끝에 남은 짧은 조각(목표의 40% 미만)은 앞 구간에 합친다
    if (local.length > 1 && dur(local[local.length - 1].a, local[local.length - 1].b) < T * 0.4) {
      const last = local.pop();
      local[local.length - 1].b = last.b;
    }
    out.push(...local);
  }
  return out;
}
const chunkOf = (i) => Math.max(0, chunks.findIndex((c) => c.a <= i && i < c.b));

// ---------- 스트림 연결 ----------
let hlsLoading = null;
function loadHlsJs() {
  if (!hlsLoading) {
    hlsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HLS_JS; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return hlsLoading;
}
async function attach(el, url) {
  if (attached.get(el) === url) return;
  attached.set(el, url);
  if (nativeHls) { el.src = url; el.preload = 'auto'; return; }
  await loadHlsJs();
  const hls = new window.Hls();
  hls.loadSource(url);
  hls.attachMedia(el);
}
const media = () => (showVideo ? video : audio);
function mediaUrl() { return showVideo ? talk.video.hls : talk.audio.hls; }

// ---------- 재생 ----------
async function play(k) {
  if (!chunks.length) return;
  ci = Math.max(0, Math.min(chunks.length - 1, k));
  save();
  mark();
  const m = media();
  (m === audio ? video : audio).pause();
  await attach(m, mediaUrl());
  const c = chunks[ci];
  target = { s: S[c.a].s, e: S[c.b - 1].e, ci };
  countEncounters();
  clearTimeout(stopTimer);
  setMetadata();
  applyRate(m);
  const mine = ++playId;
  // 아이폰은 영상 스트림을 받기 전이나 막 받기 시작했을 때 위치 이동을 무시하고 처음부터 재생한다.
  // → 소리를 끈 채 재생을 시작하고, 실제로 구간 위치에 도착한 것을 확인한 뒤 소리를 켠다.
  m.muted = true;
  if (m.readyState >= 1) m.currentTime = target.s;
  try { await m.play(); } catch (e) { m.muted = false; toast('재생할 수 없습니다. 다시 눌러 주세요.'); return; }
  const ok = await arrive(m, target.s, mine);
  if (mine !== playId) return;           // 그 사이 다른 구간을 눌렀음
  m.muted = false;
  applyRate(m);           // 아이폰은 스트림을 새로 받으면 속도를 1로 되돌리는 경우가 있어 한 번 더
  if (!ok) { m.pause(); target = null; toast('구간으로 이동하지 못했습니다. 다시 눌러 주세요.'); return; }
  watch();
}
let playId = 0;

// 위치 t에 실제로 도착할 때까지 이동을 다시 시도한다 (최대 약 5초)
async function arrive(m, t, mine) {
  for (let tries = 0; tries < 25; tries++) {
    if (mine !== playId) return false;
    if (Math.abs(m.currentTime - t) < 0.4 && !m.seeking) return true;
    if (m.readyState >= 1 && !m.seeking) m.currentTime = t;
    await new Promise((resolve) => {
      const done = () => { m.removeEventListener('seeked', done); m.removeEventListener('loadedmetadata', done); resolve(); };
      m.addEventListener('seeked', done);
      m.addEventListener('loadedmetadata', done);
      setTimeout(done, 200);
    });
  }
  return Math.abs(m.currentTime - t) < 0.4;
}

// 구간 끝을 지키는 감시: 남은 시간의 절반씩 기다렸다 확인 (화면이 꺼져도 동작하도록 타이머 사용)
function watch() {
  clearTimeout(stopTimer);
  if (!target) return;
  const m = media();
  if (m.seeking || m.currentTime < target.s - 0.25) { stopTimer = setTimeout(watch, 30); return; }
  const left = target.e - m.currentTime;
  if (left <= 0.012) {
    m.pause();
    const end = target.e;
    target = null;
    progress(end);
    return;
  }
  stopTimer = setTimeout(watch, Math.max(8, Math.min(250, (left * 1000) / 2 / (m.playbackRate || 1))));
}
for (const m of [audio, video]) {
  m.addEventListener('timeupdate', () => { if (m === media() && target) watch(); });
}

// ---------- 진행 표시: 말하는 단어를 순서대로 색칠, 긴 구간은 말하는 문장을 따라 화면 이동 ----------
function frame() {
  if (target && !document.hidden) progress(media().currentTime);
  requestAnimationFrame(frame);
}
// 단어 시간이 없는 데이터면 문장 시간을 단어 수로 고르게 나눈다
function evenTimes(x, n) { return Array.from({ length: n }, (_, k) => x.s + ((x.e - x.s) * k) / n); }

let wordEls = [];       // 지금 구간의 단어 요소 (순서대로)
let wordTimes = [];     // 각 단어의 시작 시간
let wordSent = [];      // 각 단어가 속한 문장 번호
let said = -1;          // 색칠된 마지막 단어 번호
let speaking = -1;      // 지금 말하는 문장 번호
function prepareWords() {
  wordEls = []; wordTimes = []; wordSent = [];
  const c = chunks[ci];
  const items = list.querySelectorAll('.sent');
  for (let i = c.a; i < c.b; i++) {
    const els = items[i].querySelectorAll('.w');
    const w = S[i].w || evenTimes(S[i], els.length);
    els.forEach((el, k) => { wordEls.push(el); wordTimes.push(w[k] ?? S[i].e); wordSent.push(i); });
  }
}
function progress(t) {
  const c = chunks[ci];
  if (!c) return;
  let n = -1;
  if (t !== null) while (n + 1 < wordEls.length && wordTimes[n + 1] <= t + 0.03) n++;
  if (n !== said) {
    const lo = Math.min(n, said), hi = Math.max(n, said);
    for (let k = Math.max(0, lo + 1); k <= hi; k++) wordEls[k].classList.toggle('said', k <= n);
    said = n;
    const now = n >= 0 ? wordSent[n] : c.a;
    if (now !== speaking) { speaking = now; follow(); }
  }
  const total = S[c.b - 1].e - S[c.a].s;
  const d = t === null ? 0 : Math.min(Math.max(0, t - S[c.a].s), total);
  $('clock').textContent = `${d.toFixed(1)} / ${total.toFixed(1)}초`;
}
const smoothOk = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
// 구간이 화면에 다 들어가면 구간을 가운데에, 길면 말하는 문장을 위쪽 1/3 지점에 둔다
function follow(instant) {
  const c = chunks[ci];
  const items = list.querySelectorAll('.sent');
  const first = items[c.a], last = items[c.b - 1];
  const height = last.offsetTop + last.offsetHeight - first.offsetTop;
  let top;
  if (height <= list.clientHeight * 0.8) {
    top = first.offsetTop - (list.clientHeight - height) / 2;
  } else {
    const el = items[Math.max(c.a, speaking)];
    top = el.offsetTop - list.clientHeight / 3;
  }
  list.scrollTo({ top, behavior: !instant && smoothOk() ? 'smooth' : 'auto' });
}

// ---------- 화면 ----------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function build() {
  const paras = new Set(talk.paragraphs);
  let html = '';
  S.forEach((x, i) => {
    if (i && paras.has(i)) html += `<div class="para-gap" data-before="${i}"></div>`;
    const words = x.t.trim().split(/\s+/).map((w, k) => `<span class="w" data-k="${k}">${esc(w)}</span>`).join(' ');
    html += `<button type="button" class="sent" data-i="${i}">${words}<span class="ko">${esc(x.ko || '')}</span></button>`;
  });
  list.innerHTML = html;
  $('talkTitle').textContent = talk.title;
  $('talkSub').textContent = [talk.speaker, talk.title_ko].filter(Boolean).join(' · ');
  decorate();
}

// ---------- 누르기: 짧게 = 구간 재생(저장한 단어는 뜻 창), 길게 = 뜻 창, 가린 지금 구간 = 누르는 동안 영어 보기 ----------
const LONG_PRESS = 450;
let press = null;       // {timer, x, y, done}
const hiddenNow = (i) => hideEn && chunkOf(i) === ci;
list.addEventListener('pointerdown', (ev) => {
  const b = ev.target.closest('.sent');
  if (!b) return;
  const i = +b.dataset.i;
  if (hiddenNow(i)) { peeking = true; list.classList.add('reveal'); return; }
  const w = ev.target.closest('.w');
  if (!w) return;
  press = { x: ev.clientX, y: ev.clientY, done: false };
  press.timer = setTimeout(() => { press.done = true; openWord(i, +w.dataset.k); }, LONG_PRESS);
});
list.addEventListener('pointermove', (ev) => {
  if (press && !press.done && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 10) { clearTimeout(press.timer); press = null; }
});
function endPress() {
  if (peeking) { peeking = false; list.classList.remove('reveal'); }
  if (press && !press.done) { clearTimeout(press.timer); press = null; }
}
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) list.addEventListener(type, endPress);
list.addEventListener('click', (ev) => {
  const b = ev.target.closest('.sent');
  if (!b) return;
  const i = +b.dataset.i;
  if (press && press.done) { press = null; return; }   // 길게 눌러 뜻 창을 연 뒤의 클릭은 무시
  if (hiddenNow(i)) return;                            // 가린 구간은 누르는 동안 보기만 (재생은 큰 버튼)
  const w = ev.target.closest('.w.saved');
  if (w) { openWord(i, +w.dataset.k); return; }        // 저장한 단어는 짧게 눌러도 뜻 창
  play(chunkOf(i));
});
list.addEventListener('contextmenu', (ev) => ev.preventDefault());

// ---------- F6 단어장 ----------
// 저장: { 기본형: { lex: 단어 뜻, memo, added, met: 만난 횟수, uses: { 형태: {mean, n} }, seen: { 날짜: [구간 키...] } } }
const WORDS = 'shadowing.words';
let book = {};
function loadBook() { try { book = JSON.parse(localStorage.getItem(WORDS) || '{}'); } catch (e) { book = {}; } }
function saveBook() { try { localStorage.setItem(WORDS, JSON.stringify(book)); } catch (e) { toast('단어장을 저장하지 못했습니다'); } }
const today = () => new Date().toISOString().slice(0, 10);
const bare = (t) => t.replace(/^["“‘(]+/, '').replace(/["”’).,!?;:]+$/, '');

// 문장 i의 단어 k: 기본형, 이 문장에서의 뜻, 묶음, 형태(묶음이면 묶음, 아니면 단어 그대로)
function wordAt(i, k) {
  const x = S[i];
  const tok = bare(x.t.split(/\s+/)[k]);
  const g = (x.g || [])[k];
  const combo = (x.c || []).find((c) => c[0].includes(k));
  return { tok, lemma: g ? g[0] : tok.toLowerCase(), mean: g ? g[1] : '', combo, form: combo ? combo[1] : tok.toLowerCase() };
}
// 저장한 단어에 밑줄 (묶여 나오면 묶인 단어까지)
function decorate() {
  list.querySelectorAll('.w.saved').forEach((el) => el.classList.remove('saved'));
  const items = list.querySelectorAll('.sent');
  S.forEach((x, i) => {
    (x.g || []).forEach((g, k) => {
      if (!g || !book[g[0]]) return;
      const ws = items[i].querySelectorAll('.w');
      if (ws[k]) ws[k].classList.add('saved');
      for (const c of x.c || []) if (c[0].includes(k)) c[0].forEach((j) => ws[j] && ws[j].classList.add('saved'));
    });
  });
  $('bookBtn').textContent = `단어장 (${Object.keys(book).length}개)`;
}
// 구간을 재생할 때 그 안의 저장 단어를 '만났다'고 센다 (같은 날 같은 구간은 1번)
function countEncounters() {
  const c = chunks[ci], key = `${talk.id}:${c.a}`, day = today();
  let changed = false;
  for (let i = c.a; i < c.b; i++) {
    (S[i].g || []).forEach((g, k) => {
      const e = g && book[g[0]];
      if (!e) return;
      if (!e.seen || !e.seen[day]) e.seen = { [day]: [] };
      if (e.seen[day].includes(key)) return;
      e.seen[day].push(key);
      const w = wordAt(i, k);
      e.met = (e.met || 0) + 1;
      e.uses = e.uses || {};
      e.uses[w.form] = { mean: w.combo ? w.combo[2] : w.mean, n: ((e.uses[w.form] || {}).n || 0) + 1 };
      changed = true;
    });
  }
  if (changed) saveBook();
}

// 뜻 창: i = 문장 번호(단어장 목록에서 열면 null), k = 단어 번호(목록에서는 기본형)
function openWord(i, k) {
  const w = i === null ? null : wordAt(i, k);
  const lemma = w ? w.lemma : k;
  const e = book[lemma];
  const lex = (talk.lex || {})[lemma] || (e && e.lex) || '';
  const here = w ? `<div class="sec"><span>이 문장에서</span><div class="here"><b>${esc(w.combo ? w.combo[1] : w.tok)}</b><div>${esc((w.combo ? w.combo[2] : w.mean) || '뜻 정보 없음')}</div></div></div>` : '';
  const uses = e && e.uses ? Object.entries(e.uses).sort((a, b) => b[1].n - a[1].n)
    .map(([u, v]) => `<li><span><b>${esc(u)}</b> — ${esc(v.mean || '')}</span><em>${v.n}번</em></li>`).join('') : '';
  // 순서: 이 문장에서의 뜻(묶음이면 묶음) → 단어(기본형)와 단어 뜻 → 만난 쓰임 → 문장 → 메모
  $('wordCard').innerHTML = `
    ${here}
    <div class="sec"><h2>${esc(lemma)}</h2>${lex ? `<div class="mean">${esc(lex)}</div>` : ''}</div>
    ${uses ? `<div class="sec"><span>지금까지 만난 쓰임</span><ul class="uses">${uses}</ul></div>` : ''}
    ${w ? `<div class="ctx">${esc(S[i].t)}</div>` : ''}
    ${e ? `<label class="sec"><span>내 메모</span><textarea id="memo" rows="2" placeholder="눌러서 적기">${esc(e.memo || '')}</textarea></label>
      <div class="meta">만난 횟수 ${e.met || 0}회</div>` : ''}
    <button type="button" id="wordAct" class="word-act${e ? ' remove' : ''}">${e ? '단어장에서 지우기' : '단어장에 저장'}</button>`;
  const memo = $('memo');
  if (memo) memo.addEventListener('input', () => { book[lemma].memo = memo.value; saveBook(); });
  $('wordAct').addEventListener('click', () => {
    if (book[lemma]) {
      delete book[lemma];
      toast(`${lemma} 지움`);
    } else {
      book[lemma] = { lex, memo: '', added: Date.now(), met: 1, seen: { [today()]: [`${talk.id}:${chunks[chunkOf(i)].a}`] },
        uses: { [w.form]: { mean: w.combo ? w.combo[2] : w.mean, n: 1 } } };
      toast(`${lemma} 저장`);
    }
    saveBook(); decorate(); renderBook();
    $('wordSheet').hidden = true;
  });
  $('wordSheet').hidden = false;
}
$('wordSheet').addEventListener('click', (ev) => { if (ev.target === $('wordSheet')) $('wordSheet').hidden = true; });

// 단어장 화면: 최근 저장 순
function renderBook() {
  const rows = Object.entries(book).sort((a, b) => (b[1].added || 0) - (a[1].added || 0));
  $('bookList').innerHTML = rows.length ? rows.map(([l, e]) =>
    `<li><button type="button" data-l="${esc(l)}"><b>${esc(l)}</b><span>${esc(e.lex || '')}</span><em>${e.met || 0}회</em></button></li>`).join('')
    : '<li class="empty">아직 저장한 단어가 없습니다. 스크립트의 단어를 길게 누르면 뜻을 보고 저장할 수 있습니다.</li>';
}
$('bookBtn').addEventListener('click', () => { renderBook(); $('sheet').hidden = true; $('book').hidden = false; });
$('bookClose').addEventListener('click', () => { $('book').hidden = true; });
$('bookList').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-l]');
  if (b) openWord(null, b.dataset.l);
});

let marked = null;      // 표시 중인 구간 {a, b}
function mark(instant) {
  const items = list.querySelectorAll('.sent');
  const gaps = list.querySelectorAll('.para-gap');
  if (marked) {
    for (let i = Math.max(0, marked.a - 1); i <= Math.min(S.length - 1, marked.b); i++) {
      items[i].classList.remove('on', 'near', 'first', 'last');
    }
    list.querySelectorAll('.w.said').forEach((el) => el.classList.remove('said'));
    gaps.forEach((g) => g.classList.remove('in'));
  }
  const c = chunks[ci];
  for (let i = c.a; i < c.b; i++) items[i].classList.add('on');
  items[c.a].classList.add('first');
  items[c.b - 1].classList.add('last');
  if (items[c.a - 1]) items[c.a - 1].classList.add('near');
  if (items[c.b]) items[c.b].classList.add('near');
  gaps.forEach((g) => { const i = +g.dataset.before; if (i > c.a && i < c.b) g.classList.add('in'); });
  marked = c;
  list.classList.toggle('big', !!unit.big);
  $('counter').textContent = `처음부터 듣기 · ${ci + 1} / ${chunks.length}`;
  prepareWords();
  said = -1;
  speaking = c.a;
  progress(null);
  requestAnimationFrame(() => follow(instant));
}

function applyToggles() {
  document.body.classList.toggle('no-ko', !showKo);
  $('koT').setAttribute('aria-pressed', String(showKo));
  $('videoT').setAttribute('aria-pressed', String(showVideo));
  $('videoBox').hidden = !showVideo;
  document.body.classList.toggle('hide-en', hideEn);
  $('unitBtn').textContent = hideEn ? `${unit.label} · 가림` : unit.label;
  $('hideT').setAttribute('aria-pressed', String(hideEn));
}
$('koT').addEventListener('click', () => { showKo = !showKo; applyToggles(); save(); mark(true); });
$('videoT').addEventListener('click', async () => {
  audio.pause(); video.pause(); target = null; clearTimeout(stopTimer);
  showVideo = !showVideo;
  applyToggles(); save(); mark(true);
  if (showVideo) {  // 영상을 켜면 지금 구간의 첫 장면을 보여 준다
    await attach(video, talk.video.hls);
    const t = S[chunks[ci].a].s;
    if (video.readyState >= 1) video.currentTime = t;
    else video.addEventListener('loadedmetadata', () => { video.currentTime = t; }, { once: true });
  }
});
$('play').addEventListener('click', () => play(ci));
$('prev').addEventListener('click', () => play(ci - 1));
$('next').addEventListener('click', () => play(ci + 1));

// ---------- 단위 고르기 ----------
function renderUnits() {
  $('units').innerHTML = UNITS.map((u) =>
    `<button type="button" class="unit" data-id="${u.id}" aria-pressed="${u.id === unit.id}">${u.label}</button>`).join('');
}
function setUnit(id) {
  const anchor = chunks[ci] ? chunks[ci].a : 0;
  audio.pause(); video.pause(); target = null; clearTimeout(stopTimer);
  unit = UNITS.find((u) => u.id === id) || UNITS[0];
  chunks = buildChunks();
  ci = chunkOf(anchor);
  applyToggles(); save(); mark();
}
$('unitBtn').addEventListener('click', () => { renderUnits(); $('sheet').hidden = false; });
$('units').addEventListener('click', (ev) => {
  const b = ev.target.closest('.unit');
  if (!b) return;
  $('sheet').hidden = true;
  setUnit(b.dataset.id);
});
// ---------- 재생 속도 ----------
function applyRate(m) {
  for (const el of m ? [m] : [audio, video]) { el.defaultPlaybackRate = rate; el.playbackRate = rate; el.preservesPitch = true; }
}
function showRate() {
  const b = $('speedBtn');
  b.textContent = `${rate === 1 ? '1.0' : rate}×`;
  b.classList.toggle('slow', rate !== 1);
}
$('speedBtn').addEventListener('click', () => {
  rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
  applyRate();
  showRate(); save();
  if (target) watch();    // 재생 중이면 남은 시간 계산을 새 속도로
});

$('hideT').addEventListener('click', () => {
  hideEn = !hideEn;
  endPress();
  applyToggles(); save();
});
$('sheet').addEventListener('click', (ev) => { if (ev.target === $('sheet')) $('sheet').hidden = true; });

// ---------- 이어폰·잠금화면 ----------
function setMetadata() {
  if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: S[chunks[ci].a].t, artist: `${talk.speaker} · ${unit.label} ${ci + 1}/${chunks.length}`, album: talk.title,
    artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}
if ('mediaSession' in navigator) {
  const on = (action, fn) => {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) {}
  };
  on('play', () => play(ci));             // 한 번 누르기 = 현재 구간 처음부터
  on('pause', () => play(ci));            // 재생 중에 눌러도 처음부터 (정지 버튼 없음)
  on('nexttrack', () => play(ci + 1));
  on('previoustrack', () => play(ci - 1));
  on('seekforward', () => play(ci + 1));
  on('seekbackward', () => play(ci - 1));
}

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
}

// ---------- 시작 ----------
async function start() {
  const st = load();
  loadBook();
  showKo = st.showKo !== false;
  showVideo = st.showVideo === true;
  hideEn = st.hideEn === true;
  rate = RATES.includes(st.rate) ? st.rate : 1;
  showRate();
  applyRate();
  unit = UNITS.find((u) => u.id === st.unit) || UNITS[0];
  applyToggles();
  try {
    const index = await (await fetch('talks/index.json', { cache: 'no-cache' })).json();
    const id = (index.find((t) => t.id === st.talk) || index[0] || {}).id;
    if (!id) { $('talkTitle').textContent = '강연이 없습니다'; return; }
    // 강연 데이터는 매번 서버에서 확인 (휴대폰에 남은 예전 데이터와 새 앱이 섞이지 않게)
    talk = await (await fetch(`talks/${id}.json`, { cache: 'no-cache' })).json();
  } catch (e) {
    $('talkTitle').textContent = '강연을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.';
    return;
  }
  S = talk.sentences;
  chunks = buildChunks();
  const pos = (st.pos || {})[talk.id];
  ci = chunkOf(pos >= 0 && pos < S.length ? pos : 0);
  build();
  mark(true);
  // 오디오는 미리 연결해 둔다. 영상은 아이폰이 누르기 전에 연결하면 위치 이동이 꼬이므로 첫 재생 때 연결한다.
  if (!showVideo) attach(audio, talk.audio.hls);
  save();
  requestAnimationFrame(frame);
}
start();
