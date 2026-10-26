"""국토교통부 아파트 매매 실거래가 API로 최근 거래를 내려받아 단지 × 전용면적별 시세 표를 만든다.

사용법:
    python scripts/fetch_trades.py --key <인증키> [--months 12] [시군구 코드 ...]

인증키는 공공데이터포털(data.go.kr) '국토교통부_아파트 매매 실거래가 자료' 활용신청 후 받은
일반 인증키(Decoding)다. --key 대신 환경변수 DATA_GO_KR_KEY 로 줘도 된다.
시군구 코드는 법정동 코드 앞 5자리이고, 이름을 붙이려면 41590=화성시 처럼 쓴다.
코드를 주지 않으면 서울 25개 구를 받는다.

해제된 거래(cdealType 값 있음)는 뺀다. 결과는 data/trades.js 로 저장하며,
index.html 이 <script> 로 읽으므로 파일을 바로 열어도 동작한다. 표준 라이브러리만 쓴다.
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

ENDPOINT = "apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade"
ROWS = 1000
OUT = Path(__file__).resolve().parent.parent / "data" / "trades.js"

SEOUL = {
    "11110": "종로구", "11140": "중구", "11170": "용산구", "11200": "성동구", "11215": "광진구",
    "11230": "동대문구", "11260": "중랑구", "11290": "성북구", "11305": "강북구", "11320": "도봉구",
    "11350": "노원구", "11380": "은평구", "11410": "서대문구", "11440": "마포구", "11470": "양천구",
    "11500": "강서구", "11530": "구로구", "11545": "금천구", "11560": "영등포구", "11590": "동작구",
    "11620": "관악구", "11650": "서초구", "11680": "강남구", "11710": "송파구", "11740": "강동구",
}
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
    ap.add_argument("codes", nargs="*", help="시군구 코드 (예: 11680 또는 41590=화성시)")
    ap.add_argument("--key", default=os.environ.get("DATA_GO_KR_KEY"))
    ap.add_argument("--months", type=int, default=12)
    a = ap.parse_args()
    if not a.key:
        sys.exit("인증키가 필요합니다: --key 또는 환경변수 DATA_GO_KR_KEY")

    targets = {}
    for c in a.codes or SEOUL:
        code, _, name = c.partition("=")
        targets[code] = name or SEOUL.get(code, code)
    months = recent_months(a.months)

    regions = {}
    for code, name in targets.items():
        rows = []
        for ymd in months:
            rows += fetch_month(a.key, code, ymd)
            time.sleep(0.2)
        regions[code] = {"name": name, "sido": SIDO.get(code[:2], ""), "count": len(rows), "complexes": aggregate(rows)}
        print(f"{code} {name}: {len(rows)}건", file=sys.stderr)

    data = {
        "updated": date.today().isoformat(),
        "period": f"{months[0][:4]}.{months[0][4:]}~{months[-1][:4]}.{months[-1][4:]}",
        "source": "국토교통부 아파트 매매 실거래가 (해제 거래 제외)",
        "regions": regions,
    }
    OUT.write_text("// scripts/fetch_trades.py 가 만든 파일. 직접 고치지 말 것.\nwindow.TRADES = "
                   + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"저장: {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
