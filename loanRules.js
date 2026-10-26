// 대출 규제 수치 모음. 정책이 바뀌면 이 파일의 숫자와 목록만 고치면 된다.
// 기준: 2025.6.27 / 10.15 대책 (2026년 10월 시행 기준). 비율은 소수(0.40 = 40%), 금액은 원.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LOAN_RULES = factory();
})(typeof self !== "undefined" ? self : this, function () {
  return {
    effectiveDate: "2026-10",

    // 규제지역(투기과열지구·조정대상지역). 시도 전체면 "*", 일부면 시·군·구 목록.
    // 10.15 대책 12곳 + 2026.7.1 추가 지정(6.30 대책) 화성시 동탄구·용인시 기흥구·구리시
    regulatedAreas: {
      서울: "*",
      경기: ["과천시", "광명시", "성남시 분당구", "성남시 수정구", "성남시 중원구", "수원시 영통구", "수원시 장안구",
        "수원시 팔달구", "안양시 동안구", "용인시 수지구", "의왕시", "하남시", "화성시 동탄구", "용인시 기흥구", "구리시"],
    },
    capitalArea: ["서울", "경기", "인천"],

    // 주택담보대출 규제가 적용되는 용도
    housingUses: ["아파트", "단독주택", "다가구주택", "단독·다가구 겸용", "연립·다세대"],
    apartmentUses: ["아파트"],

    // 아래 금액 상한은 규제지역뿐 아니라 수도권 전체(비규제 수도권 포함)에 적용된다.
    // 수도권·규제지역 주택구입 목적 주담대 금액 상한 (maxPrice 이하 구간, null은 그 이상 전부)
    mortgageCap_regulated_purchase: [
      { maxPrice: 1500000000, cap: 600000000 },
      { maxPrice: 2500000000, cap: 400000000 },
      { maxPrice: null, cap: 200000000 },
    ],
    relocationLoanCap: 600000000,
    // 6.27 대책: 수도권·규제지역 생활안정자금 목적 주담대 최대 1억, 이 지역 주택 2채 이상 보유자는 금지
    livingStabilityCap: 100000000,
    livingStabilityMultiHomeBanned: true,

    // 6.27 대책: 수도권·규제지역 다주택자 주택구입 주담대 금지, 1주택자는 6개월 내 처분조건부로만 가능,
    // 생애최초 LTV 70%. 규제지역은 10.15 대책으로 무주택·처분조건부 1주택 40%.
    ltv: {
      regulated: {
        noHome: 0.40,
        conditional1Home: 0.40,
        oneHome: 0.0,
        multiHome: 0.0,
        nonPurchase: 0.40, // 생활안정자금·이주비 (확인 필요)
        firstTimeBuyer: 0.70,
      },
      unregulatedCapital: {
        noHome: 0.70,
        conditional1Home: 0.70,
        oneHome: 0.0,
        multiHome: 0.0,
        nonPurchase: 0.70, // 생활안정자금·이주비 (확인 필요)
        firstTimeBuyer: 0.70,
      },
      local: { default: 0.70, firstTimeBuyer: 0.80, multiHome: 0.60 }, // 지방 다주택 60% (2차 자료 기준, 확인 필요)
      nonHousing: 0.70,
    },

    dsrLimit: { bank: 0.40, nonBank: 0.50 },
    stressRate: {
      regulated: 0.030,
      local: 0.0075,
      unregulatedCapital: 0.030, // 10.15 대책: 수도권·규제지역 주담대 하한 3.0%
      localStage3: 0.015, // localStage3Applied가 true일 때 지방에 쓸 값 (확인 필요)
    },
    stressRateFlags: { localStage3Applied: false },
    // 금리 유형별 스트레스 금리 반영 비율 (3단계, 2025.7.1~). 고정금리는 미적용.
    // 실제로는 혼합형은 고정 기간, 주기형은 금리 변동 주기에 따라 달라질 수 있다.
    stressRateTypeFactor: { variable: 1.0, mixed: 0.8, periodic: 0.4, fixed: 0.0 },
    policyMortgageExcludedFromDSR: true,

    // 정책모기지 상품별 요건과 자체 한도 (2025.6.27 이후 계약분, 2차 자료 기준이라 확인 필요).
    // 정책대출은 6억/4억/2억 가격 구간 상한 대신 상품 자체 한도를 쓴다. 소득은 부부합산 연소득.
    // household: general(일반) / newlywed(신혼) / multiChild(2자녀 이상)
    policyProducts: {
      didimdol: {
        name: "디딤돌대출",
        homes: ["noHome"],
        maxPrice: { general: 500000000, newlywed: 600000000, multiChild: 600000000 },
        maxIncome: { general: 60000000, firstTimeBuyer: 70000000, newlywed: 85000000, multiChild: 70000000 },
        cap: { general: 200000000, firstTimeBuyer: 240000000, newlywed: 320000000, multiChild: 320000000 },
        ltv: { general: 0.70, firstTimeBuyer: 0.80, firstTimeBuyerCapital: 0.70 },
      },
      bogeumjari: {
        name: "보금자리론",
        homes: ["noHome", "conditional1Home"],
        maxPrice: { general: 600000000, newlywed: 600000000, multiChild: 600000000 },
        maxIncome: { general: 70000000, firstTimeBuyer: 70000000, newlywed: 85000000, multiChild: 100000000 },
        cap: { general: 360000000, firstTimeBuyer: 420000000, newlywed: 360000000, multiChild: 360000000 },
        ltv: { general: 0.70, firstTimeBuyer: 0.80, firstTimeBuyerCapital: 0.70 },
      },
    },

    staleAfterMonths: 6, // 규정 기준일에서 이만큼 지나면 화면에 '규정 확인' 경고
    maxLoanYears: 40, // 역산 표시에 쓰는 최장 만기. 은행·지역에 따라 30년으로 제한하기도 함 (확인 필요)

    // 대출 불가·경고 조건
    jeonseLoanBlockApartmentPrice: 300000000, // 규제지역 이 금액 초과 아파트 구입 + 전세대출 보유 → 불가
    creditLoanWarnThreshold: 100000000, // 신용대출 이 금액 초과 → 1년간 규제지역 주택구입 제한 경고
    jeonseInterestInDsrForOneHome: true, // 1주택자의 수도권·규제지역 전세대출 이자를 DSR에 포함 (정책 전세대출 제외)

    // 소액임차보증금 최우선변제금 (주택임대차보호법·상가건물 임대차보호법 시행령, 2023.2.21 개정 기준)
    smallDepositTiers: [
      { id: "seoul", name: "서울특별시", house: 55000000, shop: 22000000 },
      { id: "dense", name: "과밀억제권역(서울 제외)·세종·용인·화성·김포", house: 48000000, shop: 19000000 },
      { id: "metro", name: "광역시·안산·광주(경기)·파주·이천·평택", house: 28000000, shop: 13000000 },
      { id: "other", name: "그 밖의 지역", house: 25000000, shop: 10000000 },
    ],
    smallDepositTierByRegion: {
      서울: ["seoul", ""],
      세종: ["dense", ""],
      인천: ["dense", "인천은 대부분 과밀억제권역이지만 강화·옹진 등 일부는 다릅니다. 주소에 맞게 확인하세요."],
      경기: ["dense", "경기는 시·군마다 구분이 다릅니다. 주소에 맞게 꼭 확인하세요."],
      부산: ["metro", ""], 대구: ["metro", ""], 대전: ["metro", ""], 울산: ["metro", "광역시 안의 군 지역은 '그 밖의 지역'일 수 있습니다."],
      광주전남: ["other", "광주광역시 주소라면 '광역시'를 고르세요."],
    },
    smallDepositCapRatio: 0.5, // 최우선변제 합계는 예상 낙찰가의 이 비율을 넘지 않음
  };
});
