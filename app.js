// Shadowing — F2 구간 재생
// 누르면 현재 구간을 처음부터 재생하고 구간 끝에서 멈춘다. 자동 반복·대기·자동 다음 없음.
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

let talk = null;
let S = [];
let cur = 0;
let showKo = true;
let showVideo = false;
let target = null;      // 지금 재생 중인 구간 {s, e}
let stopTimer = 0;
const attached = new WeakMap();
const signals = [];
const stops = [];

// ---------- 저장 ----------
function load() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { return {}; }
}
function save() {
  try {
    const st = load();
    st.showKo = showKo;
    st.showVideo = showVideo;
    st.talk = talk && talk.id;
    st.pos = Object.assign(st.pos || {}, talk ? { [talk.id]: cur } : {});
    localStorage.setItem(STORE, JSON.stringify(st));
  } catch (e) {}
}

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
async function play(i) {
  if (!S.length) return;
  cur = Math.max(0, Math.min(S.length - 1, i));
  save();
  mark();
  const m = media();
  (m === audio ? video : audio).pause();
  await attach(m, mediaUrl());
  const x = S[cur];
  target = { s: x.s, e: x.e, i: cur };
  clearTimeout(stopTimer);
  m.currentTime = x.s;
  setMetadata();
  try { await m.play(); } catch (e) { toast('재생할 수 없습니다. 다시 눌러 주세요.'); return; }
  watch();
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
    recordStop(m.currentTime - target.e);
    target = null;
    progress(target.e);
    return;
  }
  stopTimer = setTimeout(watch, Math.max(8, Math.min(250, (left * 1000) / 2 / (m.playbackRate || 1))));
}
for (const m of [audio, video]) {
  m.addEventListener('timeupdate', () => { if (m === media() && target) watch(); });
}

// 진행 표시: 지금 문장의 단어가 말하는 순서대로 색칠된다 (단어 시간 x.w)
function frame() {
  if (target && !document.hidden) progress(media().currentTime);
  requestAnimationFrame(frame);
}
let said = -1;  // 색칠된 마지막 단어 번호
// 단어 시간이 없는 데이터면 문장 시간을 단어 수로 고르게 나눈다
function evenTimes(x, n) { return Array.from({ length: n }, (_, k) => x.s + ((x.e - x.s) * k) / n); }
function progress(t) {
  const x = S[cur];
  if (!x) return;
  const words = list.querySelectorAll('.sent.on .w');
  let n = -1;
  if (t !== null) {
    const w = x.w || evenTimes(x, words.length);
    while (n + 1 < words.length && (w[n + 1] ?? x.e) <= t + 0.03) n++;
  }
  if (n !== said) {
    words.forEach((el, k) => el.classList.toggle('said', k <= n));
    said = n;
  }
  const d = t === null ? 0 : Math.min(Math.max(0, t - x.s), x.e - x.s);
  $('clock').textContent = `${d.toFixed(1)} / ${(x.e - x.s).toFixed(1)}초`;
}

// ---------- 화면 ----------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function build() {
  const paras = new Set(talk.paragraphs);
  let html = '';
  S.forEach((x, i) => {
    if (i && paras.has(i)) html += '<div class="para-gap"></div>';
    const words = x.t.trim().split(/\s+/).map((w) => `<span class="w">${esc(w)}</span>`).join(' ');
    html += `<button type="button" class="sent" data-i="${i}">${words}<span class="ko">${esc(x.ko || '')}</span></button>`;
  });
  list.innerHTML = html;
  $('talkTitle').textContent = talk.title;
  $('talkSub').textContent = [talk.speaker, talk.title_ko].filter(Boolean).join(' · ');
}
list.addEventListener('click', (ev) => {
  const b = ev.target.closest('.sent');
  if (b) play(+b.dataset.i);
});

let prevOn = null;
function mark(instant) {
  const items = list.querySelectorAll('.sent');
  if (prevOn !== null) {
    for (const k of [prevOn - 1, prevOn, prevOn + 1]) if (items[k]) { items[k].classList.remove('on', 'near'); items[k].querySelectorAll('.said').forEach((el) => el.classList.remove('said')); }
  }
  if (items[cur - 1]) items[cur - 1].classList.add('near');
  if (items[cur + 1]) items[cur + 1].classList.add('near');
  const on = items[cur];
  on.classList.add('on');
  prevOn = cur;
  $('counter').textContent = `처음부터 듣기 · ${cur + 1} / ${S.length}`;
  said = -1;
  progress(null);
  // 스크립트 목록 안에서만 스크롤 (화면 전체가 밀리지 않게)
  requestAnimationFrame(() => {
    const top = on.offsetTop - list.clientHeight / 2 + on.offsetHeight / 2;
    const smooth = !instant && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  });
}

function applyToggles() {
  document.body.classList.toggle('no-ko', !showKo);
  $('koT').setAttribute('aria-pressed', String(showKo));
  $('videoT').setAttribute('aria-pressed', String(showVideo));
  $('videoBox').hidden = !showVideo;
}
$('koT').addEventListener('click', () => { showKo = !showKo; applyToggles(); save(); mark(true); });
$('videoT').addEventListener('click', async () => {
  audio.pause(); video.pause(); target = null; clearTimeout(stopTimer);
  showVideo = !showVideo;
  applyToggles(); save(); mark(true);
  if (showVideo) {  // 영상을 켜면 지금 문장의 첫 장면을 보여 준다
    await attach(video, talk.video.hls);
    video.currentTime = S[cur].s;
  }
});
$('play').addEventListener('click', () => play(cur));
$('prev').addEventListener('click', () => play(cur - 1));
$('next').addEventListener('click', () => play(cur + 1));

// ---------- 이어폰·잠금화면 ----------
function setMetadata() {
  if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: S[cur].t, artist: `${talk.speaker} · ${cur + 1}/${S.length}`, album: talk.title,
    artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}
if ('mediaSession' in navigator) {
  const on = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, () => { signal(action); fn(); });
    } catch (e) {}
  };
  on('play', () => play(cur));            // 한 번 누르기 = 현재 구간 처음부터
  on('pause', () => play(cur));           // 재생 중에 눌러도 처음부터 (정지 버튼 없음)
  on('nexttrack', () => play(cur + 1));
  on('previoustrack', () => play(cur - 1));
  on('seekforward', () => play(cur + 1));
  on('seekbackward', () => play(cur - 1));
}

// ---------- 점검 화면 ----------
let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
}
const NAMES = { play: '재생', pause: '일시정지', nexttrack: '다음 곡', previoustrack: '이전 곡', seekforward: '앞으로 건너뛰기', seekbackward: '뒤로 건너뛰기' };
function signal(action) {
  const when = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  signals.unshift(`${when} ${NAMES[action] || action}${document.hidden ? ' (화면 꺼짐)' : ''}`);
  signals.length = Math.min(signals.length, 10);
  toast(`이어폰 신호: ${NAMES[action] || action}`);
  renderSheet();
}
function recordStop(late) {
  stops.unshift({ ms: Math.round(late * 1000), hidden: document.hidden });
  stops.length = Math.min(stops.length, 20);
  renderSheet();
}
function renderSheet() {
  if ($('sheet').hidden) return;
  $('signals').innerHTML = signals.map((s) => `<li>${esc(s)}</li>`).join('') || '<li>아직 없음</li>';
  const vis = stops.filter((s) => !s.hidden).map((s) => s.ms);
  const hid = stops.filter((s) => s.hidden).map((s) => s.ms);
  const stat = (a) => (a.length ? `평균 ${Math.round(a.reduce((x, y) => x + y, 0) / a.length)}ms, 최대 ${Math.max(...a)}ms (${a.length}회)` : '기록 없음');
  $('stopStats').textContent = `화면 켜짐: ${stat(vis)} / 화면 꺼짐: ${stat(hid)}`;
  $('stops').innerHTML = stops.map((s) => `<li>${s.ms}ms${s.hidden ? ' (화면 꺼짐)' : ''}</li>`).join('');
  $('engine').textContent = `${nativeHls ? '아이폰 기본 재생(HLS)' : 'hls.js'} · ${showVideo ? '영상' : '오디오'}`;
}
$('talkInfo').addEventListener('click', () => { $('sheet').hidden = false; renderSheet(); });
$('sheetClose').addEventListener('click', () => { $('sheet').hidden = true; });

// ---------- 시작 ----------
async function start() {
  const st = load();
  showKo = st.showKo !== false;
  showVideo = st.showVideo === true;
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
  const pos = (st.pos || {})[talk.id];
  cur = pos >= 0 && pos < S.length ? pos : 0;
  build();
  mark(true);
  attach(media(), mediaUrl());
  if (showVideo) video.addEventListener('loadedmetadata', () => { video.currentTime = S[cur].s; }, { once: true });
  save();
  requestAnimationFrame(frame);
}
start();
