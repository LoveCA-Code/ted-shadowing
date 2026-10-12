"""TED(유튜브) 영상의 자막을 받아 섹션 > 문단 > 문장 구조의 JSON으로 저장합니다.

사용법:
    python tools/add_talk.py https://www.youtube.com/watch?v=iG9CE55wbtY --category 마케팅
    python tools/add_talk.py --list tools/talks.txt      # "카테고리 | 주소" 줄 목록을 한 번에

결과:
    talks/<videoId>.json  (문장 + 문단/섹션 경계 + 한국어 해석)
    talks/index.json      (앱의 강연 목록)

문단/섹션은 유튜브 자막에 정보가 없어서 다음 신호로 추정합니다.
    - 문장 사이의 멈춤 길이
    - (Laughter), (Applause) 같은 반응 표기
    - So, / Now, / First, 같은 전환 표현으로 시작하는 문장
"""
import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from youtube_transcript_api import YouTubeTranscriptApi

ROOT = Path(__file__).resolve().parent.parent
TALKS = ROOT / "talks"

SOUND_TAG = re.compile(r"\([^)]*\)|\[[^\]]*\]|♪")
CREDIT = re.compile(r"^(번역|검토|Translator|Reviewer)\s*:")
SENTENCE_END = re.compile(r"[.?!][\"'”’)]*$")
TRANSITION = re.compile(
    r"^(So|Now|Okay|OK|Well|Alright|All right|First|Firstly|Second|Third|Finally|Next|"
    r"Let me|Let's|Here's|Imagine|The first|The second|The third|The last|Number \w+|"
    r"And finally|But here's|Today|In fact)\b"
)
MAX_SENTENCE = 20.0  # 초. 이보다 긴 문장은 쉼표에서 나눔


def video_id_from(arg: str) -> str:
    if re.fullmatch(r"[\w-]{11}", arg):
        return arg
    u = urllib.parse.urlparse(arg)
    if u.hostname and "youtu.be" in u.hostname:
        return u.path.lstrip("/")[:11]
    q = urllib.parse.parse_qs(u.query)
    if "v" in q:
        return q["v"][0]
    m = re.search(r"/(?:embed|shorts|live)/([\w-]{11})", u.path)
    if m:
        return m.group(1)
    sys.exit(f"영상 ID를 찾을 수 없습니다: {arg}")


def fetch_meta(vid: str):
    url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(
        f"https://www.youtube.com/watch?v={vid}"
    )
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            d = json.load(r)
            return d["title"], d.get("author_name", "")
    except Exception:
        return vid, ""


def clean(text: str) -> str:
    text = text.replace("\n", " ").replace(" ", " ")
    text = SOUND_TAG.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def snippet_end(snippets, i):
    s = snippets[i]
    end = s.start + s.duration
    if i + 1 < len(snippets) and snippets[i + 1].start > s.start:
        end = min(end, snippets[i + 1].start)
    return end


def timed_words(snippets):
    """자막 조각을 단어로 쪼개고 조각 안에서 글자 위치 비례로 시간 추정. 반응 표기 시각도 수집."""
    words, tags = [], []
    for i, s in enumerate(snippets):
        raw = s.text.replace("\n", " ")
        start, end = s.start, snippet_end(snippets, i)
        for m in SOUND_TAG.finditer(raw):
            tags.append(start + (end - start) * (m.start() / max(1, len(raw))))
        text = clean(raw)
        if not text:
            continue
        total = len(text)
        for m in re.finditer(r"\S+", text):
            words.append({
                "w": m.group(),
                "s": start + (end - start) * (m.start() / total),
                "e": start + (end - start) * (m.end() / total),
            })
    return words, tags


def build_sentences(words):
    sentences, cur = [], []

    def flush():
        if cur:
            sentences.append({
                "s": round(cur[0]["s"], 2),
                "e": round(cur[-1]["e"], 2),
                "t": " ".join(w["w"] for w in cur),
            })
            cur.clear()

    punctuated = sum(1 for w in words if SENTENCE_END.search(w["w"])) > len(words) / 60
    for k, w in enumerate(words):
        cur.append(w)
        dur = cur[-1]["e"] - cur[0]["s"]
        gap = words[k + 1]["s"] - w["e"] if k + 1 < len(words) else 0
        if punctuated:
            if SENTENCE_END.search(w["w"]):
                flush()
            elif dur > MAX_SENTENCE and w["w"].endswith((",", ";", ":", "—")):
                flush()
        else:  # 자동 자막(문장부호 없음): 멈춤과 길이로 끊기
            if (gap > 0.6 and dur > 2.5) or dur > 9:
                flush()
    flush()
    return sentences


def boundary_scores(sentences, tags):
    """문장 i 뒤에서 끊기 좋은 정도."""
    scores = []
    for i in range(len(sentences) - 1):
        a, b = sentences[i], sentences[i + 1]
        gap = max(0.0, b["s"] - a["e"])
        tag = any(a["e"] - 0.8 <= t <= b["s"] + 0.8 for t in tags)
        trans = bool(TRANSITION.match(b["t"]))
        scores.append(round(min(gap, 3.0) + (1.5 if tag else 0) + (0.6 if trans else 0), 2))
    scores.append(99)
    return scores


def split_runs(starts, ends, scores, min_len, max_len, thresh):
    """길이 [min_len, max_len] 안에서 점수가 높은 경계로 나눈 묶음의 시작 인덱스 목록."""
    n = len(starts)
    cuts, i0, i = [0], 0, 0
    while i < n - 1:
        dur = ends[i] - starts[i0]
        if dur >= min_len and scores[i] >= thresh:
            cuts.append(i + 1)
            i0 = i + 1
        elif dur >= max_len:
            cands = [j for j in range(i0, i + 1) if ends[j] - starts[i0] >= min_len] or [i]
            j = max(cands, key=lambda j: scores[j])
            cuts.append(j + 1)
            i0 = i = j + 1
            continue
        i += 1
    # 마지막 묶음이 너무 짧으면 앞 묶음에 붙임
    if len(cuts) > 1 and ends[-1] - starts[cuts[-1]] < min_len * 0.4:
        cuts.pop()
    return cuts


def attach_translation(sentences, snippets):
    buckets = [[] for _ in sentences]
    for i, s in enumerate(snippets):
        text = clean(s.text)
        if not text or CREDIT.search(text):
            continue
        s_end = snippet_end(snippets, i)

        def score(j):
            seg = sentences[j]
            overlap = min(seg["e"], s_end) - max(seg["s"], s.start)
            return overlap if overlap > 0 else -min(abs(seg["s"] - s.start), abs(seg["e"] - s_end))

        buckets[max(range(len(sentences)), key=score)].append(text)
    for seg, b in zip(sentences, buckets):
        if b:
            seg["ko"] = " ".join(b)


def add_talk(url, category="", no_ko=False):
    vid = video_id_from(url)
    api = YouTubeTranscriptApi()
    listing = api.list(vid)

    try:
        en = listing.find_manually_created_transcript(["en", "en-US", "en-GB"])
        en_source = "manual"
    except Exception:
        en = listing.find_transcript(["en", "en-US", "en-GB"])
        en_source = "auto"
    words, tags = timed_words(list(en.fetch()))
    sentences = build_sentences(words)
    scores = boundary_scores(sentences, tags)

    starts = [s["s"] for s in sentences]
    ends = [s["e"] for s in sentences]
    paragraphs = split_runs(starts, ends, scores, min_len=15, max_len=50, thresh=0.9)

    p_starts = [starts[p] for p in paragraphs]
    p_ends = [ends[(paragraphs[k + 1] if k + 1 < len(paragraphs) else len(sentences)) - 1] for k in range(len(paragraphs))]
    p_scores = [scores[(paragraphs[k + 1] if k + 1 < len(paragraphs) else len(sentences)) - 1] for k in range(len(paragraphs))]
    sections = split_runs(p_starts, p_ends, p_scores, min_len=90, max_len=240, thresh=2.4)

    ko_source = None
    if not no_ko:
        ko = None
        try:
            ko = listing.find_manually_created_transcript(["ko"])
            ko_source = "manual"
        except Exception:
            try:
                ko = en.translate("ko")
                ko_source = "machine"
            except Exception:
                pass
        if ko:
            try:
                attach_translation(sentences, list(ko.fetch()))
            except Exception:
                ko_source = None

    title, channel = fetch_meta(vid)
    talk = {
        "id": vid,
        "title": title,
        "channel": channel,
        "category": category,
        "enSource": en_source,
        "koSource": ko_source,
        "sentences": sentences,
        "paragraphs": paragraphs,
        "sections": sections,
    }
    TALKS.mkdir(exist_ok=True)
    (TALKS / f"{vid}.json").write_text(json.dumps(talk, ensure_ascii=False, indent=1), encoding="utf-8")

    index_path = TALKS / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    old = next((t for t in index if t["id"] == vid), None)
    entry = {
        "id": vid,
        "title": title,
        "category": category or (old or {}).get("category", ""),
        "duration": round(ends[-1]) if ends else 0,
        "sentences": len(sentences),
        "paragraphs": len(paragraphs),
        "sections": len(sections),
    }
    if old:
        index[index.index(old)] = entry
    else:
        index.append(entry)
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"✔ [{entry['category'] or '-'}] {title}")
    print(f"  문장 {len(sentences)} · 문단 {len(paragraphs)} · 섹션 {len(sections)} · "
          f"영어 {en_source} · 한국어 {ko_source or '없음'}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("url", nargs="?")
    p.add_argument("--category", "-c", default="")
    p.add_argument("--list", help='"카테고리 | 유튜브 주소" 형식의 줄 목록 파일')
    p.add_argument("--no-ko", action="store_true", help="한국어 해석을 받지 않음")
    args = p.parse_args()

    if args.list:
        for line in Path(args.list).read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            cat, _, url = line.rpartition("|")
            try:
                add_talk(url.strip(), cat.strip(), args.no_ko)
            except Exception as e:
                print(f"✘ {url.strip()}: {e.__class__.__name__}: {str(e).splitlines()[0][:120]}")
            time.sleep(20)  # 유튜브 차단 방지
    elif args.url:
        add_talk(args.url, args.category, args.no_ko)
    else:
        p.print_help()


if __name__ == "__main__":
    main()
