"""TED(유튜브) 영상의 자막을 받아 문장 단위 구간 JSON으로 저장합니다.

사용법:
    python tools/add_talk.py https://www.youtube.com/watch?v=iG9CE55wbtY
    python tools/add_talk.py iG9CE55wbtY --no-ko

결과:
    talks/<videoId>.json  (문장 구간 + 한국어 해석)
    talks/index.json      (앱의 영상 목록)
"""
import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from youtube_transcript_api import YouTubeTranscriptApi

ROOT = Path(__file__).resolve().parent.parent
TALKS = ROOT / "talks"

# (Laughter), (Applause) 같은 효과음 표기
SOUND_TAG = re.compile(r"\((?:[^)]*)\)|\[(?:[^\]]*)\]|♪")
SENTENCE_END = re.compile(r"[.?!][\"'”’)]*$")
CREDIT = re.compile(r"^(번역|검토|Translator|Reviewer)\s*:")
MAX_SEGMENT = 14.0  # 초. 이보다 긴 문장은 쉼표에서 나눔


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


def fetch_title(vid: str) -> str:
    url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(
        f"https://www.youtube.com/watch?v={vid}"
    )
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return json.load(r)["title"]
    except Exception:
        return vid


def clean(text: str) -> str:
    text = text.replace("\n", " ").replace(" ", " ")
    text = SOUND_TAG.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def timed_words(snippets):
    """자막 조각을 단어 단위로 쪼개고, 조각 안에서 글자 위치 비례로 시간을 추정."""
    words = []
    for i, s in enumerate(snippets):
        text = clean(s.text)
        if not text:
            continue
        start = s.start
        # 자막 duration은 다음 자막과 겹치는 경우가 많아 다음 시작 시각으로 자름
        end = s.start + s.duration
        if i + 1 < len(snippets):
            end = min(end, snippets[i + 1].start) or end
        total = len(text)
        pos = 0
        for m in re.finditer(r"\S+", text):
            w_start = start + (end - start) * (m.start() / total)
            w_end = start + (end - start) * (m.end() / total)
            words.append({"w": m.group(), "s": w_start, "e": w_end})
            pos = m.end()
    return words


def build_segments(words):
    segments, cur = [], []

    def flush():
        if cur:
            segments.append({
                "start": round(cur[0]["s"], 2),
                "end": round(cur[-1]["e"], 2),
                "text": " ".join(w["w"] for w in cur),
            })
            cur.clear()

    for w in words:
        cur.append(w)
        dur = cur[-1]["e"] - cur[0]["s"]
        if SENTENCE_END.search(w["w"]):
            flush()
        elif dur > MAX_SEGMENT and w["w"].endswith((",", ";", ":", "—")):
            flush()
    flush()
    return merge_short(segments)


def merge_short(segments, min_len=2.0, max_len=7.0):
    """'Good.' 같은 아주 짧은 구간은 다음 구간과 합쳐 따라하기 좋은 길이로."""
    out = []
    for seg in segments:
        if out:
            prev = out[-1]
            prev_short = prev["end"] - prev["start"] < min_len
            this_short = seg["end"] - seg["start"] < min_len
            if (prev_short or this_short) and seg["end"] - prev["start"] <= max_len:
                prev["end"] = seg["end"]
                prev["text"] += " " + seg["text"]
                continue
        out.append(dict(seg))
    return out


def attach_translation(segments, snippets):
    buckets = [[] for _ in segments]
    for i, s in enumerate(snippets):
        text = clean(s.text)
        if not text or CREDIT.search(text):
            continue
        s_end = s.start + s.duration
        if i + 1 < len(snippets):
            s_end = min(s_end, snippets[i + 1].start) or s_end

        # 시간이 가장 많이 겹치는 구간(없으면 가장 가까운 구간)에 배정
        def score(j):
            seg = segments[j]
            overlap = min(seg["end"], s_end) - max(seg["start"], s.start)
            return overlap if overlap > 0 else -min(abs(seg["start"] - s.start), abs(seg["end"] - s_end))

        buckets[max(range(len(segments)), key=score)].append(text)
    for seg, b in zip(segments, buckets):
        if b:
            seg["ko"] = " ".join(b)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("url")
    p.add_argument("--no-ko", action="store_true", help="한국어 해석을 받지 않음")
    args = p.parse_args()

    vid = video_id_from(args.url)
    api = YouTubeTranscriptApi()
    listing = api.list(vid)

    try:
        en = listing.find_manually_created_transcript(["en", "en-US", "en-GB"])
    except Exception:
        en = listing.find_transcript(["en", "en-US", "en-GB"])
        print("※ 사람이 만든 영어 자막이 없어 자동 자막을 사용합니다 (문장 구분이 부정확할 수 있음)")
    en_snips = list(en.fetch())
    segments = build_segments(timed_words(en_snips))

    ko_source = None
    if not args.no_ko:
        try:
            ko = listing.find_manually_created_transcript(["ko"])
            ko_source = "manual"
        except Exception:
            try:
                ko = en.translate("ko")
                ko_source = "machine"
            except Exception:
                ko = None
        if ko:
            attach_translation(segments, list(ko.fetch()))

    talk = {
        "id": vid,
        "title": fetch_title(vid),
        "koSource": ko_source,
        "segments": segments,
    }
    TALKS.mkdir(exist_ok=True)
    (TALKS / f"{vid}.json").write_text(
        json.dumps(talk, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    index_path = TALKS / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    index = [t for t in index if t["id"] != vid]
    index.insert(0, {
        "id": vid,
        "title": talk["title"],
        "count": len(segments),
        "duration": round(segments[-1]["end"]) if segments else 0,
    })
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"✔ {talk['title']}")
    print(f"  문장 {len(segments)}개, 한국어: {ko_source or '없음'} → talks/{vid}.json")


if __name__ == "__main__":
    main()
