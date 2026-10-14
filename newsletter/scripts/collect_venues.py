"""Venue 행사 일정 수집기.

venue별 공식 행사 일정 페이지에서 지정한 달의 행사를 모아
data/events/YYYY-MM.json 과 마크다운 표(섹션 3용)를 만든다.

사용법:
    python scripts/collect_venues.py 2026-11
    python scripts/collect_venues.py 2026-11 --venues coex,kintex

수집 방식은 02-sources.md "수집 메모" 참고.
"""

import argparse
import calendar
import json
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
KST = timezone(timedelta(hours=9))

# 코엑스는 브라우저가 아닌 요청을 403으로 막는다.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9",
}
MAX_PAGES = 20
REQUEST_DELAY = 0.5  # 초. venue 서버 부담을 줄이기 위한 요청 간격

CATEGORY_MAP = {
    "exhibition": "전시",
    "exhibiton": "전시",  # 코엑스마곡 페이지 오타
    "전시": "전시",
    "전시회": "전시",
    "convention": "회의",
    "회의": "회의",
    "event": "기타",
    "이벤트": "기타",
    "문화행사": "기타",
    "기타행사": "기타",
}


def get(url, retries=3, **params):
    for attempt in range(retries):
        time.sleep(REQUEST_DELAY * (attempt * 4 + 1))
        try:
            res = requests.get(url, params=params, headers=HEADERS, timeout=30)
            res.raise_for_status()
            return res
        except requests.ConnectionError:
            # 코엑스마곡은 가끔 연결을 끊는다 → 잠시 쉬고 다시 시도
            if attempt == retries - 1:
                raise


def norm_category(raw):
    return CATEGORY_MAP.get(raw.strip().lower(), raw.strip() or "기타")


def parse_range(text):
    """'2026.11.04 - 2026.11.07' / '2026-11-04 ~ 2026-11-07' -> (date, date)"""
    found = re.findall(r"(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})", text)
    if not found:
        return None, None
    days = [date(int(y), int(m), int(d)) for y, m, d in found]
    return days[0], days[-1]


def event(venue, category, title, start, end, place="", url=""):
    return {
        "venue": venue,
        "category": norm_category(category),
        "title": re.sub(r"\s+", " ", title).strip(),
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "place": re.sub(r"\s+", " ", place).strip(),
        "url": url,
    }


# --- 코엑스 / 코엑스마곡 (같은 플랫폼) -------------------------------------

def collect_coex_family(venue, base_url, first, last):
    events = []
    seen_pages = set()
    for page in range(1, MAX_PAGES + 1):
        res = get(
            base_url,
            search_start_date=first.strftime("%Y.%m.%d"),
            search_end_date=last.strftime("%Y.%m.%d"),
            list_type="LIST",
            var_page=page,
        )
        soup = BeautifulSoup(res.text, "html.parser")
        items = [
            li for li in soup.select("#EXHIBITIONS_LIST_TYPE_SECTION li.BlogPost-item")
            if li.select(".BlogEventItemCont")  # "결과 없음" 안내 항목 제외
        ]
        if not items:
            break
        signature = tuple(li.get_text(strip=True)[:80] for li in items)
        if signature in seen_pages:  # 마지막 페이지를 넘기면 같은 목록이 반복되는 경우 대비
            break
        seen_pages.add(signature)
        for li in items:
            # 항목마다 hover용/기본용 내용이 두 번 들어 있어 마지막 블록만 읽는다.
            cont = li.select(".BlogEventItemCont")[-1]
            start, end = parse_range(cont.select_one(".BlogEventItemCont-date").get_text())
            if not start:
                continue
            hall = cont.select_one(".BlogEventItemCont-hall")
            link = li.select_one("a.BlogEventItem-link")
            events.append(event(
                venue,
                cont.select_one(".BlogEventItemCont-cate").get_text(),
                cont.select_one(".BlogEventItemCont-tit").get_text(),
                start, end,
                hall.get_text() if hall else "",
                link["href"].split("?")[0] if link else "",
            ))
    return events


def collect_coex(first, last):
    return collect_coex_family("코엑스", "https://www.coex.co.kr/event/full-schedules/", first, last)


def collect_coex_magok(first, last):
    return collect_coex_family("코엑스마곡", "https://coexmagok.co.kr/event-schedule/list/", first, last)


# --- 킨텍스 (월별 JSON, 날짜별로 묶여 있음) ----------------------------------

def collect_kintex(first, last):
    by_title = {}
    month = date(first.year, first.month, 1)
    # 앞달에 시작해 이번 달로 이어지는 행사의 시작일을 찾기 위해 직전 달도 읽는다.
    prev = (month - timedelta(days=1)).replace(day=1)
    for ym in (prev, month):
        res = get(
            "https://www.kintex.com/web/ko/event/calendarEventList.do",
            yearMonth=ym.strftime("%Y%m"),
            searchType="11",
        )
        for row in res.json():
            day = date.fromisoformat(row["start"][:10])
            category = row.get("id", "")
            for title in re.split(r"<br\s*/?>", row.get("description", "")):
                title = BeautifulSoup(title, "html.parser").get_text().strip()
                if title:
                    by_title.setdefault((title, category), set()).add(day)

    events = []
    for (title, category), days in by_title.items():
        # 연속된 날짜를 하나의 행사 기간으로 합친다.
        days = sorted(days)
        run_start = prev_day = days[0]
        for d in days[1:] + [None]:
            if d is not None and d - prev_day == timedelta(days=1):
                prev_day = d
                continue
            events.append(event("킨텍스", category, title, run_start, prev_day))
            if d is not None:
                run_start = prev_day = d
    return events


# --- 벡스코 -------------------------------------------------------------------

def bexco_url(href):
    m = re.search(r"event_seq=(\d+)", href)
    if not m:
        return ""
    return f"https://www.bexco.co.kr/kor/CMS/EventScheduleMgr/view.do?mCode=MN214&event_seq={m.group(1)}"


def collect_bexco(first, last):
    events = []
    seen = set()
    for page in range(1, MAX_PAGES + 1):
        res = get(
            "https://www.bexco.co.kr/kor/CMS/EventScheduleMgr/list.do",
            mCode="MN214", searchID="sch005", page=page,
            schStartDate=first.isoformat(), schEndDate=last.isoformat(),
        )
        soup = BeautifulSoup(res.text, "html.parser")
        boxes = soup.select("span.txtBox")
        new = 0
        for box in boxes:
            subject = box.select_one(".subject")
            date_el = box.select_one(".date")
            if not subject or not date_el:
                continue
            start, end = parse_range(date_el.get_text())
            if not start:
                continue
            link = box.find_parent("a")
            key = (subject.get_text(strip=True), start)
            if key in seen:
                continue
            seen.add(key)
            new += 1
            icon = box.select_one(".eventIcon")
            place = box.select_one(".place")
            events.append(event(
                "벡스코",
                icon.get_text() if icon else "",
                subject.get_text(),
                start, end,
                place.get_text() if place else "",
                bexco_url(link.get("href", "") if link else ""),
            ))
        if not new:
            break
    return events


# --- SETEC --------------------------------------------------------------------

def collect_setec(first, last):
    events = []
    seen = set()
    for page in range(1, MAX_PAGES + 1):
        res = get(
            "https://www.setec.or.kr/front/schedule/list.do",
            searchSDate=first.isoformat(), searchEDate=last.isoformat(), pageIndex=page,
        )
        soup = BeautifulSoup(res.text, "html.parser")
        new = 0
        for txt in soup.select("div.txt"):
            title = txt.find("strong")
            lis = [li.get_text(" ", strip=True) for li in txt.select("li")]
            period = next((x for x in lis if x.startswith("기간")), "")
            place = next((x for x in lis if x.startswith("장소")), "")
            start, end = parse_range(period)
            if not title or not start:
                continue
            # SETEC은 같은 행사가 표기만 다르게 두 번 등록된 경우가 있다 (예: "러닝 엑스포"/"러닝엑스포").
            key = (re.sub(r"\s+", "", title.get_text()), start, end)
            if key in seen:
                continue
            seen.add(key)
            new += 1
            a = txt.find_parent("a")
            m = re.search(r"fn_view\('(\d+)'\)", a.get("onclick", "")) if a else None
            events.append(event(
                "SETEC", "전시", title.get_text(), start, end,
                place.split(":", 1)[-1],
                f"https://www.setec.or.kr/front/schedule/view.do?sIdx={m.group(1)}" if m else "",
            ))
        if not new:
            break
    return events


COLLECTORS = {
    "coex": collect_coex,
    "coex_magok": collect_coex_magok,
    "kintex": collect_kintex,
    "bexco": collect_bexco,
    "setec": collect_setec,
}


# --- 자사 수행 이력 표시 ---------------------------------------------------------

def load_our_events():
    path = ROOT / "data" / "our-events.txt"
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    return [l.strip().lower() for l in lines if l.strip() and not l.startswith("#")]


def mark_our_events(events, keywords):
    for e in events:
        name = re.sub(r"\s+", "", e["title"]).lower()
        e["past_client"] = any(re.sub(r"\s+", "", k) in name for k in keywords)


# --- 출력 ---------------------------------------------------------------------

def to_markdown(events, month_label):
    order = ["코엑스", "코엑스마곡", "킨텍스", "벡스코", "SETEC"]
    lines = [f"<!-- collect_venues.py 자동 생성 ({month_label}) — 전시·회의만 표시, ⭐ = 과거 자사 수행 행사 -->"]
    for venue in order:
        rows = [e for e in events if e["venue"] == venue and e["category"] in ("전시", "회의")]
        if not rows:
            continue
        lines += ["", f"### {venue}", "| 기간 | 구분 | 행사명 | 장소 | 자사 |", "|---|---|---|---|---|"]
        for e in rows:
            s, t = date.fromisoformat(e["start_date"]), date.fromisoformat(e["end_date"])
            period = f"{s:%m.%d}" if s == t else f"{s:%m.%d}~{t:%m.%d}"
            title = f"[{e['title']}]({e['url']})" if e["url"] else e["title"]
            title = title.replace("|", "\\|")
            lines.append(f"| {period} | {e['category']} | {title} | {e['place'] or '-'} | {'⭐' if e['past_client'] else ''} |")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("month", help="YYYY-MM")
    parser.add_argument("--venues", default=",".join(COLLECTORS), help="쉼표로 구분한 venue id")
    args = parser.parse_args()

    year, month = map(int, args.month.split("-"))
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])

    events, failures = [], []
    for vid in args.venues.split(","):
        try:
            got = COLLECTORS[vid](first, last)
            print(f"{vid}: {len(got)}건", file=sys.stderr)
            if not got:
                failures.append(f"{vid}: 0건 (페이지 구조 변경 가능성)")
            events += got
        except Exception as exc:  # 한 venue가 실패해도 나머지는 계속 수집
            print(f"{vid}: 실패 - {exc}", file=sys.stderr)
            failures.append(f"{vid}: {exc}")

    # 지정한 달과 겹치는 행사만 남긴다.
    events = [e for e in events if e["start_date"] <= last.isoformat() and e["end_date"] >= first.isoformat()]
    events.sort(key=lambda e: (e["venue"], e["start_date"], e["title"]))
    mark_our_events(events, load_our_events())

    out_dir = ROOT / "data" / "events"
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "month": args.month,
        "collected_at": datetime.now(KST).isoformat(timespec="seconds"),
        "failures": failures,
        "events": events,
    }
    (out_dir / f"{args.month}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out_dir / f"{args.month}.md").write_text(to_markdown(events, args.month), encoding="utf-8")
    print(f"총 {len(events)}건 → data/events/{args.month}.json, .md", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
