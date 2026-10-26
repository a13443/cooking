"""법원경매정보 '용도별 매각통계' 엑셀을 읽어 시도 × 용도 매각가율 표를 만든다.

사용법:
    python scripts/build_rates.py <1년차 폴더> <2년차 폴더> <3년차 폴더> <4년차 폴더> <5년차 폴더>

폴더는 오래된 해부터 최근 해 순서로 준다. 각 폴더에는 그 1년치 '용도별 매각통계 (N).xls'가 있다
(N은 아래 REGION_FILES 순서, 번호 없는 파일은 0번). 특별자치도 시행 전처럼 없는 파일은 비워 둔다.

낙찰가율 = max(5년 매각가율, 1년 50% + 3년 30% + 5년 20% 가중평균)
각 기간 매각가율은 그 기간 매각가 합계 ÷ 감정가 합계이고, 3년·5년은 최근 1년을 포함한다.
결과는 data/auction_rates.json, data/auction_rates.csv 로 저장하고,
index.html 안의 RATES 데이터 블록도 함께 갱신한다.
"""
import csv
import glob
import json
import re
import sys
from pathlib import Path

import xlrd

YEAR_LABELS = ["2021.10~2022.09", "2022.10~2023.09", "2023.10~2024.09", "2024.10~2025.09", "2025.10~2026.09"]
WEIGHTS = {"1y": 0.5, "3y": 0.3, "5y": 0.2}
PERIOD_YEARS = {"1y": 1, "3y": 3, "5y": 5}  # 최근 몇 해를 묶는지
MIN_SOLD = 30  # 이 건수 미만이면 상위 분류 → 전국 순서로 대체

# 다운로드 파일 끝 번호 → 시도. 행정구역 변경으로 나뉜 지역은 하나로 합친다.
REGION_FILES = {
    0: "서울", 1: "광주전남", 2: "부산", 3: "대구", 4: "인천", 5: "광주전남", 6: "대전",
    7: "울산", 8: "세종", 9: "경기", 10: "강원", 11: "충북", 12: "충남", 13: "전북",
    14: "광주전남", 15: "경북", 16: "경남", 17: "제주", 18: "강원", 19: "전북",
}
REGION_ORDER = ["서울", "경기", "인천", "강원", "충북", "충남", "대전", "세종", "전북",
                "광주전남", "경북", "대구", "경남", "부산", "울산", "제주"]

# (원본 키, 화면 이름, 상위 분류 소계 키)
USES = [
    ("아파트", "아파트", None),
    ("단독주택,다가구주택/단독주택", "단독주택", "단독주택,다가구주택/소계"),
    ("단독주택,다가구주택/다가구주택", "다가구주택", "단독주택,다가구주택/소계"),
    ("단독주택,다가구주택/겸용", "단독·다가구 겸용", "단독주택,다가구주택/소계"),
    ("연립주택,다세대", "연립·다세대", None),
    ("대지,임야,전답/대지", "대지", "대지,임야,전답/소계"),
    ("대지,임야,전답/임야", "임야", "대지,임야,전답/소계"),
    ("대지,임야,전답/전답", "전·답", "대지,임야,전답/소계"),
    ("대지,임야,전답/겸용", "토지 겸용", "대지,임야,전답/소계"),
    ("상가,오피스텔,근린시설/상가", "상가", "상가,오피스텔,근린시설/소계"),
    ("상가,오피스텔,근린시설/오피스텔", "오피스텔", "상가,오피스텔,근린시설/소계"),
    ("상가,오피스텔,근린시설/근린시설", "근린시설", "상가,오피스텔,근린시설/소계"),
    ("상가,오피스텔,근린시설/겸용", "상가 겸용", "상가,오피스텔,근린시설/소계"),
]
HEADER = ["물건용도", "물건용도", "경매건수", "매각건수", "감정가(단위:원)", "매각가(단위:원)", "매각율", "매각가율"]


def num(x):
    x = str(x).replace(",", "").replace("%", "").strip()
    return float(x) if x else 0.0


def read_sheet(path):
    sheet = xlrd.open_workbook(path).sheet_by_index(0)
    if sheet.row_values(0)[:8] != HEADER:
        raise ValueError(f"{path}: 예상한 머리글이 아닙니다")
    rows, group = {}, ""
    for i in range(1, sheet.nrows):
        v = sheet.row_values(i)
        group = v[0] or group
        key = f"{group}/{v[1]}" if v[1] else group
        rows[key] = {"sold": num(v[3]), "appr": num(v[4]), "price": num(v[5])}
    return rows


def add(tables):
    out = {}
    for rows in tables:
        for key, r in rows.items():
            o = out.setdefault(key, {"sold": 0.0, "appr": 0.0, "price": 0.0})
            for f in o:
                o[f] += r[f]
    return out


def rate(r):
    # 매각가율 = 매각가 합계 ÷ 감정가 합계 (원본 통계와 같은 정의)
    return round(r["price"] / r["appr"] * 100, 1) if r and r["appr"] else None


def pick(rows, national, key, parent, label):
    """그 기간의 지역 값을 고르고, 표본이 적으면 상위 분류 소계 → 전국 순으로 대체한다."""
    own = rows.get(key)
    if own and own["sold"] >= MIN_SOLD:
        return {"rate": rate(own), "source": "지역", "n": int(own["sold"])}
    if parent and rows.get(parent) and rows[parent]["sold"] >= MIN_SOLD:
        p = rows[parent]
        return {"rate": rate(p), "source": "지역 소계", "n": int(p["sold"])}
    n = national[key]
    return {"rate": rate(n), "source": "전국", "n": int(n["sold"])}


def main(year_dirs):
    if len(year_dirs) != len(YEAR_LABELS):
        raise SystemExit(f"연도 폴더 {len(YEAR_LABELS)}개가 필요합니다")
    years = []  # 해마다 {시도: [시트, ...]}
    for d in year_dirs:
        grouped = {}
        for path in glob.glob(str(Path(d) / "*.xls")):
            m = re.search(r"\((\d+)\)", path)
            grouped.setdefault(REGION_FILES[int(m.group(1)) if m else 0], []).append(read_sheet(path))
        years.append(grouped)

    periods = {}
    for pid, count in PERIOD_YEARS.items():
        recent = years[-count:]
        regions = {name: add([t for y in recent for t in y.get(name, [])]) for name in REGION_ORDER}
        periods[pid] = {"regions": regions, "national": add(list(regions.values()))}

    data = {"periods": {pid: f"{YEAR_LABELS[-c][:7]}~{YEAR_LABELS[-1][-7:]}" for pid, c in PERIOD_YEARS.items()},
            "weights": WEIGHTS, "minSold": MIN_SOLD, "uses": [u[1] for u in USES],
            "regions": REGION_ORDER, "national": {}, "table": {}}

    def combine(parts):
        weighted = round(sum(WEIGHTS[pid] * parts[pid]["rate"] for pid in WEIGHTS), 1)
        five = parts["5y"]["rate"]
        return {"weighted": weighted, "applied": max(weighted, five),
                "basis": "5년 매각가율" if five > weighted else "가중평균", "parts": parts}

    for key, label, _ in USES:
        parts = {}
        for pid, per in periods.items():
            n = per["national"][key]
            parts[pid] = {"rate": rate(n), "source": "전국", "n": int(n["sold"])}
        data["national"][label] = combine(parts)

    for name in REGION_ORDER:
        data["table"][name] = {}
        for key, label, parent in USES:
            parts = {pid: pick(per["regions"][name], per["national"], key, parent, label)
                     for pid, per in periods.items()}
            data["table"][name][label] = combine(parts)

    root = Path(__file__).resolve().parent.parent
    (root / "data/auction_rates.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    with open(root / "data/auction_rates.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        head = ["지역", "용도"]
        for pid in PERIOD_YEARS:
            head += [f"{pid} 매각가율", f"{pid} 기준", f"{pid} 표본건수"]
        w.writerow(head + ["가중평균", "적용 낙찰가율", "적용 근거"])
        for name in REGION_ORDER + ["전국"]:
            for label in data["uses"]:
                c = data["national"][label] if name == "전국" else data["table"][name][label]
                row = [name, label]
                for pid in PERIOD_YEARS:
                    p = c["parts"][pid]
                    row += [p["rate"], p["source"], p["n"]]
                w.writerow(row + [c["weighted"], c["applied"], c["basis"]])

    html = root / "index.html"
    if html.exists():
        text = html.read_text(encoding="utf-8")
        block = "/*RATES*/" + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "/*END*/"
        text = re.sub(r"/\*RATES\*/.*?/\*END\*/", lambda _: block, text, flags=re.S)
        html.write_text(text, encoding="utf-8")
    cells = [data["table"][r][u] for r in REGION_ORDER for u in data["uses"]]
    print("저장 완료:", ", ".join(f"{b} {sum(c['basis'] == b for c in cells)}칸" for b in ("가중평균", "5년 매각가율")))


if __name__ == "__main__":
    main(sys.argv[1:])
