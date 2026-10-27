"""국토교통부 아파트 매매 실거래가 API로 최근 거래를 내려받아 단지 × 전용면적별 시세 표를 만든다.

사용법:
    python scripts/fetch_trades.py --key <인증키> [--months 12] [지역 ...]

인증키는 공공데이터포털(data.go.kr) '국토교통부_아파트 매매 실거래가 상세 자료' 활용신청 후 받은
일반 인증키(Decoding)다. --key 대신 환경변수 DATA_GO_KR_KEY 로 줘도 된다.
지역은 묶음 이름(서울, 경기규제, 제주) 또는 시군구 코드(법정동 코드 앞 5자리)다.
코드에 이름을 붙이려면 41135=성남시 분당구 처럼 쓴다. 지역을 주지 않으면 서울을 받는다.

기존 data/trades.js 가 있으면 새로 받은 지역만 바꾸고 나머지 지역은 그대로 둔다(--replace 면 새로 만듦).
해제된 거래(cdealType 값 있음)는 뺀다. index.html 이 <script> 로 읽으므로 파일을 바로 열어도 동작한다.
표준 라이브러리만 쓴다.
"""
import argparse
import json
import os
import ssl
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

# 상세 자료 API (층·해제여부 포함). 기본 자료 API는 RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade
ENDPOINT = "apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev"
ROWS = 1000
OUT = Path(__file__).resolve().parent.parent / "data" / "trades.js"

SEOUL = {
    "11110": "종로구", "11140": "중구", "11170": "용산구", "11200": "성동구", "11215": "광진구",
    "11230": "동대문구", "11260": "중랑구", "11290": "성북구", "11305": "강북구", "11320": "도봉구",
    "11350": "노원구", "11380": "은평구", "11410": "서대문구", "11440": "마포구", "11470": "양천구",
    "11500": "강서구", "11530": "구로구", "11545": "금천구", "11560": "영등포구", "11590": "동작구",
    "11620": "관악구", "11650": "서초구", "11680": "강남구", "11710": "송파구", "11740": "강동구",
}
# 경기 규제지역. 이름은 loanRules.js 의 regulatedAreas 와 같게 써서 화면이 시·군·구를 자동으로 고른다.
# 화성시는 2026.2.1 분구 후 동탄구가 41597 이며, API는 분구 전 거래도 새 코드로 준다.
GG_REGULATED = {
    "41290": "과천시", "41210": "광명시", "41135": "성남시 분당구", "41131": "성남시 수정구",
    "41133": "성남시 중원구", "41117": "수원시 영통구", "41111": "수원시 장안구", "41115": "수원시 팔달구",
    "41173": "안양시 동안구", "41465": "용인시 수지구", "41430": "의왕시", "41450": "하남시",
    "41597": "화성시 동탄구", "41463": "용인시 기흥구", "41310": "구리시",
}
JEJU = {"50110": "제주시", "50130": "서귀포시"}
GROUPS = {"서울": SEOUL, "경기규제": GG_REGULATED, "제주": JEJU}
KNOWN = {**SEOUL, **GG_REGULATED, **JEJU}

# 시도 코드(앞 2자리) → 화면의 시도 이름 (build_rates.py 의 지역 통합과 같게)
SIDO = {
    "11": "서울", "26": "부산", "27": "대구", "28": "인천", "29": "광주전남", "30": "대전", "31": "울산",
    "36": "세종", "41": "경기", "42": "강원", "51": "강원", "43": "충북", "44": "충남", "45": "전북",
    "52": "전북", "46": "광주전남", "47": "경북", "48": "경남", "50": "제주",
}


def recent_months(n, today=None):
    """신고 지연을 감안해 이번 달을 빼고 지난달부터 n개월 (YYYYMM, 오래된 순)."""
    today = today or date.today()
    y, m = today.year, today.month
    out = []
    for _ in range(n):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        out.append(f"{y}{m:02d}")
    return out[::-1]


def text(item, tag):
    el = item.find(tag)
    return (el.text or "").strip() if el is not None else ""


def parse_items(xml_text):
    """응답 XML → (거래 목록, 전체 건수). 오류 응답이면 예외."""
    root = ET.fromstring(xml_text)
    code = root.findtext("header/resultCode", "").strip()
    if code not in ("000", "00"):
        msg = root.findtext("header/resultMsg", "") or root.findtext(".//returnAuthMsg", "") or xml_text[:200]
        raise RuntimeError(f"API 오류 {code}: {msg.strip()}")
    rows = []
    for it in root.iter("item"):
        if text(it, "cdealType"):
            continue  # 해제된 거래
        try:
            rows.append({
                "apt": text(it, "aptNm"),
                "dong": text(it, "umdNm"),
                "area": float(text(it, "excluUseAr")),
                "price": int(text(it, "dealAmount").replace(",", "")) * 10000,  # 만원 → 원
                "date": f"{text(it, 'dealYear')}.{int(text(it, 'dealMonth')):02d}.{int(text(it, 'dealDay')):02d}",
                "floor": text(it, "floor"),
            })
        except ValueError:
            continue
    total = int(root.findtext("body/totalCount", "0") or 0)
    return rows, total


def get(url):
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return r.read().decode("utf-8")
    except (ssl.SSLError, urllib.error.URLError) as e:
        if url.startswith("https://") and "SSL" in str(e):
            return get("http://" + url[len("https://"):])  # 일부 환경은 https 인증서 오류가 난다
        raise


def fetch_month(key, lawd, ymd):
    rows, page = [], 1
    while True:
        q = urllib.parse.urlencode({"serviceKey": key, "LAWD_CD": lawd, "DEAL_YMD": ymd,
                                    "pageNo": page, "numOfRows": ROWS})
        got, total = parse_items(get(f"https://{ENDPOINT}?{q}"))
        rows += got
        if page * ROWS >= total:
            return rows
        page += 1
        time.sleep(0.2)


def aggregate(rows):
    """단지(이름+법정동) × 전용면적(㎡ 정수) → 건수, 중위가, 최근 거래."""
    groups = {}
    for r in rows:
        k = f"{r['apt']} ({r['dong']})"
        groups.setdefault(k, {}).setdefault(str(round(r["area"])), []).append(r)
    out = {}
    for k in sorted(groups):
        out[k] = {}
        for area in sorted(groups[k], key=int):
            g = sorted(groups[k][area], key=lambda r: r["date"])
            out[k][area] = {
                "n": len(g),
                "median": int(statistics.median(r["price"] for r in g)),
                "last": {"date": g[-1]["date"], "price": g[-1]["price"], "floor": g[-1]["floor"]},
            }
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("areas", nargs="*", help="묶음(서울, 경기규제, 제주) 또는 시군구 코드 (예: 11680, 41135=성남시 분당구)")
    ap.add_argument("--key", default=os.environ.get("DATA_GO_KR_KEY"))
    ap.add_argument("--months", type=int, default=12)
    ap.add_argument("--replace", action="store_true", help="기존 지역을 지우고 새로 만든다")
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    if not a.key:
        sys.exit("인증키가 필요합니다: --key 또는 환경변수 DATA_GO_KR_KEY")

    targets = {}
    for c in a.areas or ["서울"]:
        if c in GROUPS:
            targets.update(GROUPS[c])
            continue
        code, _, name = c.partition("=")
        if not (code.isdigit() and len(code) == 5):
            sys.exit(f"알 수 없는 지역: {c} (묶음: {', '.join(GROUPS)} 또는 5자리 시군구 코드)")
        targets[code] = name or KNOWN.get(code, code)
    months = recent_months(a.months)
    period = f"{months[0][:4]}.{months[0][4:]}~{months[-1][:4]}.{months[-1][4:]}"

    data = None if a.replace else load(a.out)
    data = data or {"source": "국토교통부 아파트 매매 실거래가 (해제 거래 제외)", "regions": {}}
    for code, name in targets.items():
        rows = []
        for ymd in months:
            rows += fetch_month(a.key, code, ymd)
            time.sleep(0.2)
        data["regions"][code] = {"name": name, "sido": SIDO.get(code[:2], ""), "period": period,
                                 "count": len(rows), "complexes": aggregate(rows)}
        print(f"{code} {name}: {len(rows)}건", file=sys.stderr)

    data["updated"] = date.today().isoformat()
    data["period"] = period
    a.out.write_text("// scripts/fetch_trades.py 가 만든 파일. 직접 고치지 말 것.\nwindow.TRADES = "
                     + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"저장: {a.out} (지역 {len(data['regions'])}곳)", file=sys.stderr)


def load(path):
    """기존 trades.js 를 읽는다. 없거나 빈 데이터면 None."""
    if not path.exists():
        return None
    t = path.read_text(encoding="utf-8")
    start = t.find("window.TRADES = ")
    if start < 0:
        return None
    body = t[start + len("window.TRADES = "):].strip().rstrip(";")
    return None if body == "null" else json.loads(body)


if __name__ == "__main__":
    # 윈도우에서 출력을 파이프·Git Bash로 보내면 cp949로 나가 한글이 깨지므로 UTF-8로 고정
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    main()
