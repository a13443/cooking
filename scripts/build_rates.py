"""법원경매정보 '용도별 매각통계' 엑셀을 읽어 시도 × 용도 매각가율 표를 만든다.

사용법:
    python scripts/build_rates.py <지역 파일 폴더> <전국 파일.xls>

지역 폴더에는 '용도별 매각통계 (N).xls' 파일 20개가 있어야 한다(N은 아래 REGION_FILES 순서).
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

PERIOD = "2026.01~2026.09"
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


def main(region_dir, national_path):
    grouped = {}
    for path in glob.glob(str(Path(region_dir) / "*.xls")):
        n = int(re.search(r"\((\d+)\)", path).group(1))
        grouped.setdefault(REGION_FILES[n], []).append(read_sheet(path))
    regions = {name: add(tables) for name, tables in grouped.items()}
    national = read_sheet(national_path)

    data = {"period": PERIOD, "minSold": MIN_SOLD, "uses": [u[1] for u in USES],
            "regions": REGION_ORDER, "national": {}, "table": {}}
    for key, label, _ in USES:
        n = national[key]
        data["national"][label] = {"rate": rate(n), "sold": int(n["sold"])}

    for name in REGION_ORDER:
        rows = regions[name]
        data["table"][name] = {}
        for key, label, parent in USES:
            own = rows.get(key)
            cell = {"sold": int(own["sold"]) if own else 0, "rate": rate(own)}
            if own and own["sold"] >= MIN_SOLD:
                cell.update(applied=rate(own), source="지역", n=int(own["sold"]))
            elif parent and rows.get(parent) and rows[parent]["sold"] >= MIN_SOLD:
                p = rows[parent]
                cell.update(applied=rate(p), source="지역 소계", n=int(p["sold"]))
            else:
                cell.update(applied=data["national"][label]["rate"], source="전국",
                            n=data["national"][label]["sold"])
            data["table"][name][label] = cell

    root = Path(__file__).resolve().parent.parent
    (root / "data/auction_rates.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    with open(root / "data/auction_rates.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["지역", "용도", "지역 매각건수", "지역 매각가율", "적용 매각가율", "적용 기준", "적용 표본건수"])
        for name in REGION_ORDER:
            for label in data["uses"]:
                c = data["table"][name][label]
                w.writerow([name, label, c["sold"], c["rate"] if c["rate"] is not None else "",
                            c["applied"], c["source"], c["n"]])

    html = root / "index.html"
    if html.exists():
        text = html.read_text(encoding="utf-8")
        block = "/*RATES*/" + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "/*END*/"
        text = re.sub(r"/\*RATES\*/.*?/\*END\*/", lambda _: block, text, flags=re.S)
        html.write_text(text, encoding="utf-8")
    print("저장 완료:", ", ".join(f"{k} {sum(1 for r in REGION_ORDER for u in data['uses'] if data['table'][r][u]['source']==k)}칸"
                              for k in ("지역", "지역 소계", "전국")))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
