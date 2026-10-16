// 앱 화면 파일은 휴대폰에 저장해 두고 바로 띄운다 (빠른 시작). 새 버전을 올릴 때는 CACHE 이름을 바꾼다
// → 브라우저가 바뀐 sw.js를 발견해 최신 파일을 새로 받고, 페이지가 한 번 새로고침된다.
// 강연 데이터(talks/)는 매번 서버에서 확인하고, 인터넷이 안 되면 저장본을 쓴다.
// 소리·영상 재생은 TED 서버에서 하므로 인터넷이 필요하다.
const CACHE = 'shadowing-v25';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  // 휴대폰에 남은 예전 파일이 아니라 서버의 최신 파일로 채운다
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});
// 페이지가 '기다리는 새 버전'을 발견하면 바로 교체하도록 요청한다
self.addEventListener('message', (e) => { if (e.data === 'skip') self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/talks/')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
