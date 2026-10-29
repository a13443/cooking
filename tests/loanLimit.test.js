// 실행: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../loanRules.js");
const { calcLoanLimit, classifyLocation, annualPayment, principalFromAnnual, suggestions } = require("../loanLimit.js");

// 기본 입력: 서울 아파트 무주택 주택구입, 소득·DSR 여유 충분, 낙찰가율 90%, 방공제 없음
function input(over = {}) {
  return {
    region: "서울", district: "", use: "아파트", price: 14e8, auctionRate: 0.90, ltvOverride: null,
    homes: "noHome", firstTimeBuyer: false, purpose: "purchase",
    annualIncome: 10e8, existingAnnualPayment: 0, sector: "bank", rateType: "variable", rate: 0.04, years: 30,
    policyMortgage: false, creditLoanTotal: 0,
    jeonse: { has: false, inCapitalOrRegulated: false, policy: false, annualInterest: 0 },
    depositTier: "seoul", houseUnits: 0, shopUnits: 0,
    ...over,
  };
}
const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

test("소재지 구분: 서울·경기 규제 15곳은 규제지역, 그 밖의 수도권, 지방", () => {
  assert.equal(classifyLocation("서울", "", rules), "regulated");
  assert.equal(classifyLocation("경기", "과천시", rules), "regulated");
  assert.equal(classifyLocation("경기", "화성시 동탄구", rules), "regulated");
  assert.equal(classifyLocation("경기", "구리시", rules), "regulated");
  assert.equal(classifyLocation("경기", "기타", rules), "unregulatedCapital");
  assert.equal(classifyLocation("인천", "", rules), "unregulatedCapital");
  assert.equal(classifyLocation("부산", "", rules), "local");
});

test("규제지역 무주택 시가 14억: LTV 40% = 5.6억 < 상한 6억 → LTV가 결정", () => {
  const r = calcLoanLimit(input({ price: 14e8 }), rules);
  assert.equal(r.collateralLimit, 5.6e8);
  assert.equal(r.cap.cap, 6e8);
  assert.equal(r.finalLimit, 5.6e8);
  assert.equal(r.binding, "ltv");
});

test("규제지역 무주택 시가 20억: LTV 8억 > 상한 4억 → 상한이 결정", () => {
  const r = calcLoanLimit(input({ price: 20e8 }), rules);
  assert.equal(r.collateralLimit, 8e8);
  assert.equal(r.finalLimit, 4e8);
  assert.equal(r.binding, "cap");
});

test("규제지역 무주택 시가 30억: 상한 2억", () => {
  const r = calcLoanLimit(input({ price: 30e8 }), rules);
  assert.equal(r.finalLimit, 2e8);
  assert.equal(r.binding, "cap");
});

test("규제지역 다주택자 주택구입: 대출 불가", () => {
  const r = calcLoanLimit(input({ homes: "multiHome" }), rules);
  assert.equal(r.ltv.ratio, 0);
  assert.equal(r.finalLimit, 0);
  assert.equal(r.binding, "blocked");
  assert.ok(r.blocks.some((m) => m.includes("다주택")));
});

test("규제지역 처분조건부 1주택 주택구입: LTV 40%", () => {
  const r = calcLoanLimit(input({ homes: "conditional1Home", price: 10e8 }), rules);
  assert.equal(r.ltv.ratio, 0.40);
  assert.equal(r.finalLimit, 4e8);
});

test("생활안정자금은 수도권·규제지역 1억 상한 (시가 20억 → LTV 8억이어도 1억)", () => {
  const r = calcLoanLimit(input({ price: 20e8, purpose: "livingStability" }), rules);
  assert.equal(r.cap.cap, 1e8);
  assert.equal(r.finalLimit, 1e8);
  assert.equal(r.binding, "cap");
});

test("수도권 다주택자 생활안정자금: 불가", () => {
  const r = calcLoanLimit(input({ region: "인천", price: 5e8, purpose: "livingStability", homes: "multiHome" }), rules);
  assert.equal(r.binding, "blocked");
  assert.ok(r.blocks.some((m) => m.includes("생활안정자금")));
});

test("지방 생활안정자금은 상한 없음", () => {
  const r = calcLoanLimit(input({ region: "부산", price: 3e8, purpose: "livingStability", depositTier: "metro" }), rules);
  assert.equal(r.cap, null);
  assert.equal(r.finalLimit, 2.1e8);
});

test("이주비는 집값과 관계없이 6억 상한 (시가 30억)", () => {
  const r = calcLoanLimit(input({ price: 30e8, purpose: "relocation" }), rules);
  assert.equal(r.cap.cap, 6e8);
  assert.equal(r.finalLimit, 6e8);
  assert.equal(r.binding, "cap");
});

test("지방 주택 3억 무주택: LTV 70%, 상한 없음, 스트레스 0.75%", () => {
  const r = calcLoanLimit(input({ region: "부산", price: 3e8, depositTier: "metro" }), rules);
  assert.equal(r.location, "local");
  assert.equal(r.cap, null);
  assert.equal(r.collateralLimit, 2.1e8);
  near(r.dsr.stress, 0.0075, 1e-12);
  assert.equal(r.finalLimit, 2.1e8);
});

test("비규제 수도권: 스트레스 3%, LTV 70%", () => {
  const r = calcLoanLimit(input({ region: "인천", price: 5e8 }), rules);
  assert.equal(r.location, "unregulatedCapital");
  near(r.dsr.stress, 0.03, 1e-12);
  assert.equal(r.ltv.ratio, 0.70);
});

test("비규제 수도권도 가격 구간 상한 적용 (인천 20억 → 4억)", () => {
  const r = calcLoanLimit(input({ region: "인천", price: 20e8 }), rules);
  assert.equal(r.cap.cap, 4e8);
  assert.equal(r.finalLimit, 4e8);
  assert.equal(r.binding, "cap");
});

test("비규제 수도권 다주택·1주택(처분 계획 없음) 주택구입: 불가, 처분조건부 1주택은 70%", () => {
  for (const homes of ["multiHome", "oneHome"]) {
    const r = calcLoanLimit(input({ region: "인천", price: 5e8, homes }), rules);
    assert.equal(r.binding, "blocked", homes);
  }
  const r = calcLoanLimit(input({ region: "인천", price: 5e8, homes: "conditional1Home" }), rules);
  assert.equal(r.ltv.ratio, 0.70);
  assert.equal(r.finalLimit, 3.5e8);
});

test("생애최초: 수도권 70%, 지방 80%", () => {
  const capital = calcLoanLimit(input({ region: "인천", price: 5e8, firstTimeBuyer: true }), rules);
  assert.equal(capital.ltv.ratio, 0.70);
  const local = calcLoanLimit(input({ region: "부산", price: 3e8, firstTimeBuyer: true, depositTier: "metro" }), rules);
  assert.equal(local.ltv.ratio, 0.80);
});

test("2026.7.1 추가 규제지역 동탄구 10억: LTV 40% = 4억", () => {
  const r = calcLoanLimit(input({ region: "경기", district: "화성시 동탄구", price: 10e8, depositTier: "dense" }), rules);
  assert.equal(r.location, "regulated");
  assert.equal(r.finalLimit, 4e8);
});

test("DSR이 결정: 연소득 5천만, 은행 40%, 4% + 스트레스 3%, 30년", () => {
  const r = calcLoanLimit(input({ annualIncome: 5e7, price: 14e8 }), rules);
  const expected = principalFromAnnual(2e7, 0.07, 30);
  near(r.dsr.limit, expected);
  near(expected, 250_525_000, 1e5); // 약 2.5억
  assert.equal(r.binding, "dsr");
  near(r.finalLimit, expected);
  // 한도만큼 빌리면 스트레스 금리 기준 DSR이 정확히 40%
  near(annualPayment(r.finalLimit, 0.07, 30) / 5e7, 0.40, 1e-9);
});

test("비은행은 DSR 50%라 한도가 더 크다", () => {
  const bank = calcLoanLimit(input({ annualIncome: 5e7 }), rules);
  const nonBank = calcLoanLimit(input({ annualIncome: 5e7, sector: "nonBank" }), rules);
  assert.ok(nonBank.dsr.limit > bank.dsr.limit);
});

test("고정금리는 스트레스 금리 미적용", () => {
  const r = calcLoanLimit(input({ rateType: "fixed" }), rules);
  assert.equal(r.dsr.stress, 0);
});

test("정책모기지는 DSR 계산 제외", () => {
  const r = calcLoanLimit(input({ annualIncome: 3e7, policyMortgage: true, price: 5e8 }), rules);
  assert.equal(r.dsr.excluded, true);
  assert.equal(r.dsr.limit, null);
  assert.equal(r.finalLimit, 2e8);
});

test("기존 대출 상환액이 DSR 한도를 넘으면 추가 여력 0", () => {
  const r = calcLoanLimit(input({ annualIncome: 5e7, existingAnnualPayment: 2.5e7 }), rules);
  assert.equal(r.finalLimit, 0);
  assert.equal(r.binding, "dsr");
});

test("규제지역 3억 초과 아파트 구입 + 전세대출 보유: 불가", () => {
  const r = calcLoanLimit(input({ price: 5e8, jeonse: { has: true, inCapitalOrRegulated: true, policy: false, annualInterest: 0 } }), rules);
  assert.equal(r.finalLimit, 0);
  assert.ok(r.blocks.some((m) => m.includes("전세대출")));
});

test("신용대출 1억 초과: 규제지역 주택구입 제한 경고", () => {
  const r = calcLoanLimit(input({ creditLoanTotal: 1.5e8 }), rules);
  assert.ok(r.warnings.some((m) => m.includes("신용대출")));
  const ok = calcLoanLimit(input({ creditLoanTotal: 1e8 }), rules);
  assert.ok(!ok.warnings.some((m) => m.includes("신용대출")));
});

test("1주택자 수도권·규제지역 전세대출 이자는 DSR에 포함, 정책 전세대출은 제외", () => {
  const base = { region: "부산", price: 3e8, homes: "oneHome", purpose: "livingStability", annualIncome: 5e7 };
  const jeonse = { has: true, inCapitalOrRegulated: true, policy: false, annualInterest: 6e6 };
  const withJeonse = calcLoanLimit(input({ ...base, jeonse }), rules);
  assert.equal(withJeonse.dsr.existingAnnual, 6e6);
  const policy = calcLoanLimit(input({ ...base, jeonse: { ...jeonse, policy: true } }), rules);
  assert.equal(policy.dsr.existingAnnual, 0);
  assert.ok(withJeonse.dsr.limit < policy.dsr.limit);
});

test("낙찰가율이 LTV보다 낮으면 낙찰가율이 결정 (비주택 임야, 낙찰가율 50%)", () => {
  const r = calcLoanLimit(input({ region: "제주", use: "임야", price: 3e8, auctionRate: 0.504, depositTier: "other" }), rules);
  assert.equal(r.binding, "auction");
  near(r.finalLimit, 151_200_000);
});

test("선순위 채권 차감: 서울 14억 LTV 5.6억 − 선순위 2억 = 3.6억", () => {
  const r = calcLoanLimit(input({ seniorDebt: 2e8 }), rules);
  assert.equal(r.seniorDebt, 2e8);
  assert.equal(r.collateralLimit, 3.6e8);
  assert.equal(r.finalLimit, 3.6e8);
  assert.equal(r.binding, "ltv");
});

test("선순위 채권이 담보인정액 이상이면 0과 경고", () => {
  const r = calcLoanLimit(input({ seniorDebt: 6e8 }), rules);
  assert.equal(r.finalLimit, 0);
  assert.ok(r.warnings.some((m) => m.includes("선순위")));
});

test("역산: DSR이 결정할 때 필요 소득·만기·고정금리·비은행 제안", () => {
  const base = input({ annualIncome: 5e7, years: 20 });
  const before = calcLoanLimit(base, rules).finalLimit;
  const tips = suggestions(base, rules);
  const by = Object.fromEntries(tips.map((t) => [t.key, t]));
  assert.deepEqual(Object.keys(by).sort(), ["fixed", "income", "nonBank", "years"]);
  // 제안 소득으로 다시 계산하면 담보 기준 한도(5.6억)까지 나온다
  assert.equal(by.income.amount, 5.6e8);
  assert.equal(calcLoanLimit({ ...base, annualIncome: by.income.value }, rules).finalLimit, 5.6e8);
  for (const k of ["years", "fixed", "nonBank"]) assert.ok(by[k].amount > before, k);
  assert.equal(by.years.value, 30); // 수도권·규제지역 주담대 만기 30년 제한 (6.27 대책)
});

test("만기: 수도권은 30년까지만 제안·초과 시 경고, 지방은 40년 제안", () => {
  const seoul = input({ annualIncome: 5e7, years: 30 });
  assert.ok(!suggestions(seoul, rules).some((t) => t.key === "years"));
  assert.ok(calcLoanLimit({ ...seoul, years: 40 }, rules).warnings.some((w) => w.includes("30년 이내")));
  const jeju = input({ region: "제주", district: "제주시", price: 5e8, annualIncome: 3e7, years: 30 });
  const tip = suggestions(jeju, rules).find((t) => t.key === "years");
  assert.equal(tip.value, 40);
  assert.ok(!calcLoanLimit({ ...jeju, years: 40 }, rules).warnings.some((w) => w.includes("년 이내")));
});

test("역산: 기존 대출 상환 제안, DSR이 결정하지 않으면 제안 없음", () => {
  const tips = suggestions(input({ annualIncome: 8e7, existingAnnualPayment: 1e7 }), rules);
  assert.ok(tips.some((t) => t.key === "repayExisting"));
  assert.deepEqual(suggestions(input(), rules), []);
});

test("금리 유형별 스트레스 반영: 혼합형 80%, 주기형 40% (수도권 3% 기준)", () => {
  near(calcLoanLimit(input({ rateType: "mixed" }), rules).dsr.stress, 0.024, 1e-12);
  near(calcLoanLimit(input({ rateType: "periodic" }), rules).dsr.stress, 0.012, 1e-12);
});

test("지방 다주택자 주택구입: LTV 60%", () => {
  const r = calcLoanLimit(input({ region: "부산", price: 3e8, homes: "multiHome", depositTier: "metro" }), rules);
  assert.equal(r.ltv.ratio, 0.60);
  assert.equal(r.finalLimit, 1.8e8);
});

test("디딤돌 생애최초: 인천 4억, 연소득 6,500만 → 자체 한도 2.4억, DSR 제외", () => {
  const r = calcLoanLimit(input({ region: "인천", price: 4e8, firstTimeBuyer: true, annualIncome: 6.5e7,
    policyProduct: "didimdol", depositTier: "dense" }), rules);
  assert.deepEqual(r.blocks, []);
  assert.equal(r.ltv.ratio, 0.70);
  assert.equal(r.cap.cap, 2.4e8);
  assert.equal(r.dsr.excluded, true);
  assert.equal(r.finalLimit, 2.4e8);
  assert.equal(r.binding, "cap");
});

test("디딤돌 요건 미달: 주택가격 초과·소득 초과·유주택은 불가", () => {
  const base = { region: "인천", price: 4e8, annualIncome: 5e7, policyProduct: "didimdol", depositTier: "dense" };
  assert.equal(calcLoanLimit(input({ ...base, price: 5.5e8 }), rules).binding, "blocked");
  assert.equal(calcLoanLimit(input({ ...base, annualIncome: 6.5e7 }), rules).binding, "blocked");
  assert.equal(calcLoanLimit(input({ ...base, homes: "conditional1Home" }), rules).binding, "blocked");
  // 신혼부부는 6억 이하 주택, 소득 8,500만까지
  const nw = calcLoanLimit(input({ ...base, price: 5.5e8, annualIncome: 8e7, household: "newlywed" }), rules);
  assert.deepEqual(nw.blocks, []);
});

test("디딤돌 신혼부부 서울 6억: 규제지역 LTV 40%가 상품 LTV보다 낮아 2.4억", () => {
  const r = calcLoanLimit(input({ price: 6e8, annualIncome: 8e7, policyProduct: "didimdol", household: "newlywed" }), rules);
  assert.equal(r.ltv.ratio, 0.40);
  assert.equal(r.cap.cap, 3.2e8);
  assert.equal(r.finalLimit, 2.4e8);
});

test("보금자리론: 처분조건부 1주택 가능, 다주택 불가, 한도 3.6억", () => {
  const base = { region: "부산", price: 6e8, annualIncome: 6e7, policyProduct: "bogeumjari", depositTier: "metro" };
  const ok = calcLoanLimit(input({ ...base, homes: "conditional1Home" }), rules);
  assert.deepEqual(ok.blocks, []);
  assert.equal(ok.finalLimit, 3.6e8);
  assert.equal(calcLoanLimit(input({ ...base, homes: "multiHome" }), rules).binding, "blocked");
});

test("기존 예시: 1억 × min(70%, 70%) − 2,500만 = 4,500만", () => {
  const r = calcLoanLimit(input({ region: "강원", use: "단독주택", price: 1e8, auctionRate: 0.70, depositTier: "other", houseUnits: 1 }), rules);
  near(r.finalLimit, 45_000_000);
});

test("비주택(임야·상가)은 지역과 관계없이 기타대출 스트레스 금리 1.5%", () => {
  const seoul = calcLoanLimit(input({ region: "서울", use: "근린시설", price: 10e8, depositTier: "seoul" }), rules);
  const local = calcLoanLimit(input({ region: "부산", use: "임야", price: 3e8, depositTier: "metro" }), rules);
  near(seoul.dsr.stress, 0.015, 1e-12);
  near(local.dsr.stress, 0.015, 1e-12);
  assert.equal(seoul.cap, null);
  assert.equal(seoul.ltv.ratio, 0.70);
});

test("비주택은 보유 주택 수·대출 목적과 관계없이 LTV 70%, 대출 불가 없음", () => {
  const r = calcLoanLimit(input({ region: "서울", use: "상가", price: 10e8, homes: "multiHome", purpose: "purchase", depositTier: "seoul" }), rules);
  assert.equal(r.ltv.ratio, 0.70);
  assert.equal(r.blocks.length, 0);
});

test("비주택 담보대출에는 신용대출 1억 초과 주택구입 제한 경고를 띄우지 않음", () => {
  const r = calcLoanLimit(input({ region: "서울", use: "대지", price: 5e8, creditLoanTotal: 1.5e8, depositTier: "seoul" }), rules);
  assert.ok(!r.warnings.some((m) => m.includes("신용대출")));
});

test("만기일시상환(비주택): DSR 연 원리금 = 원금 ÷ 8년 + 연 이자", () => {
  // 연소득 5천만 × 40% = 2천만, 금리 4% + 스트레스 1.5% → 2천만 ÷ (1/8 + 0.055) = 1억 1,111만
  const r = calcLoanLimit(input({ region: "부산", use: "임야", price: 10e8, auctionRate: 0.9, annualIncome: 5e7,
    repayment: "bullet", years: 2, depositTier: "metro" }), rules);
  near(r.dsr.limit, 2e7 / (1 / 8 + 0.055));
  assert.equal(r.binding, "dsr");
  // 만기(2년·10년)는 일시상환 DSR에 영향 없음
  const r10 = calcLoanLimit(input({ region: "부산", use: "임야", price: 10e8, auctionRate: 0.9, annualIncome: 5e7,
    repayment: "bullet", years: 10, depositTier: "metro" }), rules);
  near(r10.dsr.limit, r.dsr.limit);
});

test("가계대출 총액 1억 이하 체크: DSR 한도보다 1억 − 기존 잔액이 크면 그 금액까지", () => {
  const base = { region: "부산", use: "임야", price: 3e8, depositTier: "metro", annualIncome: 1e7, dsrExempt: true, existingLoanBalance: 3e7 }; // DSR만으로는 약 5,870만원
  const r = calcLoanLimit(input(base), rules);
  assert.equal(r.dsr.exempt, true);
  assert.equal(r.dsr.limit, 7e7);
  // 소득이 없어도 1억 이내는 가능
  const noIncome = calcLoanLimit(input({ ...base, annualIncome: 0 }), rules);
  assert.equal(noIncome.dsr.limit, 7e7);
  // DSR 한도가 더 크면 DSR 한도
  const rich = calcLoanLimit(input({ ...base, annualIncome: 2e8 }), rules);
  assert.ok(!rich.dsr.exempt && rich.dsr.limit > 7e7);
});

test("비주택 포함 토지거래허가구역 체크: 비주택 LTV 40%", () => {
  const r = calcLoanLimit(input({ region: "서울", use: "대지", price: 5e8, permitZone: true, depositTier: "seoul" }), rules);
  assert.equal(r.ltv.ratio, 0.40);
  assert.equal(r.collateralLimit, 2e8);
});

// ---- 임대사업자(RTI)·경매(경락잔금) ----
// 제주 상가 10억, 낙찰가율 70%, 상가 1호(그 밖의 지역 1,000만), 월세 400만·보증금 5천만, 변동 5%
function biz(over = {}) {
  return input({
    region: "제주", use: "상가", price: 10e8, auctionRate: 0.70, depositTier: "other", houseUnits: 0, shopUnits: 1,
    borrower: "business", monthlyRent: 4e6, rentDeposit: 5e7, rate: 0.05, ...over,
  });
}

test("임대사업자 상가: DSR·가격 구간 상한 없이 RTI 1.5배로 한도", () => {
  const r = calcLoanLimit(biz(), rules);
  assert.equal(r.collateralLimit, 6.9e8); // 10억 × 70% − 1,000만
  assert.equal(r.cap, null);
  assert.ok(r.dsr.excluded);
  // 연 임대소득 4,800만 + 5천만 × 2.5% = 4,925만 → ÷ 1.5 ÷ (5% + 스트레스 1%p)
  near(r.rti.limit, 49.25e6 / 1.5 / 0.06);
  assert.equal(r.binding, "rti");
  assert.equal(r.finalLimit, r.rti.limit);
});

test("임대사업자 고정금리: 스트레스 금리 없음", () => {
  const r = calcLoanLimit(biz({ rateType: "fixed" }), rules);
  assert.equal(r.rti.stress, 0);
  near(r.rti.limit, 49.25e6 / 1.5 / 0.05);
});

test("RTI: 해당 건물 기존 대출 이자를 빼고 계산", () => {
  const r = calcLoanLimit(biz({ existingBuildingInterest: 1e7 }), rules);
  near(r.rti.limit, (49.25e6 / 1.5 - 1e7) / 0.06);
});

test("RTI 한도가 1억 미만이어도 1억 이하 대출은 RTI 심사 제외", () => {
  const r = calcLoanLimit(biz({ monthlyRent: 3e5, rentDeposit: 0 }), rules);
  assert.ok(r.rti.exempt);
  assert.equal(r.rti.limit, 1e8);
});

test("RTI 역산: 담보 기준 한도까지 받으려면 필요한 월세, 고정금리 한도", () => {
  const tips = suggestions(biz(), rules);
  const rent = tips.find((t) => t.key === "rent");
  // 6.9억 × 6% × 1.5 = 6,210만 − 보증금 간주 125만 → 월 507.08만 → 만원 올림
  assert.equal(rent.value, 5080000);
  assert.equal(rent.amount, 6.9e8);
  assert.ok(tips.some((t) => t.key === "fixed"));
});

test("주택 임대사업자: 수도권·규제지역 주택담보대출 금지, 지방 60%", () => {
  const seoul = calcLoanLimit(input({ borrower: "business", monthlyRent: 3e6 }), rules);
  assert.equal(seoul.binding, "blocked");
  assert.ok(seoul.blocks.some((m) => m.includes("금지")));
  const busan = calcLoanLimit(input({ region: "부산", use: "다가구주택", price: 10e8, borrower: "business", monthlyRent: 5e6, rentDeposit: 0 }), rules);
  assert.equal(busan.ltv.ratio, 0.60);
  assert.equal(busan.rti.threshold, 1.25);
});

test("경매 상가(개인): min(담보가치 × LTV 70%, 낙찰가 × 80%), 담보가치 = min(감정가, 낙찰가)", () => {
  const r = calcLoanLimit(input({ region: "제주", use: "상가", price: 10e8, deal: "auction", bid: 7e8, depositTier: "other", shopUnits: 1, annualIncome: 0 }), rules);
  assert.equal(r.auction.value, 7e8);
  near(r.auction.byLtv, 4.9e8);
  assert.equal(r.auction.byBid, 5.6e8);
  near(r.collateralLimit, 4.8e8); // 4.9억 − 상가 1호 1,000만
  assert.equal(r.binding, "ltv");
});

test("경매 규제지역 아파트(개인 무주택): 낙찰가 기준 LTV 40%와 가격 구간 상한", () => {
  const r = calcLoanLimit(input({ price: 15e8, deal: "auction", bid: 14e8 }), rules);
  assert.equal(r.auction.byLtv, 5.6e8);
  assert.equal(r.cap.cap, 6e8); // 담보가치 14억 → 15억 이하 구간
  assert.equal(r.finalLimit, 5.6e8);
});

test("경매: 낙찰가를 비우면 감정가 × 낙찰가율로 예상하고 경고", () => {
  const r = calcLoanLimit(biz({ deal: "auction", bid: 0 }), rules);
  assert.equal(r.auction.bid, 7e8);
  assert.ok(r.auction.bidEstimated);
  assert.ok(r.warnings.some((m) => m.includes("예상")));
});

test("경매: 낙찰가 인정 비율이 LTV보다 낮으면 낙찰가 기준이 결정, 비은행은 90%", () => {
  const bank = calcLoanLimit(biz({ deal: "auction", bid: 7e8, ltvOverride: 0.9, monthlyRent: 2e7 }), rules);
  assert.equal(bank.auction.bidRatio, 0.8);
  assert.equal(bank.binding, "bid");
  assert.equal(bank.collateralLimit, 5.5e8); // 7억 × 80% − 1,000만
  const nonBank = calcLoanLimit(biz({ deal: "auction", bid: 7e8, ltvOverride: 0.9, monthlyRent: 2e7, sector: "nonBank" }), rules);
  assert.equal(nonBank.auction.bidRatio, 0.9);
  assert.equal(nonBank.collateralLimit, 6.2e8);
});

test("RTI 스트레스 금리: 입력값이 최소 1%p보다 크면 입력값, 작으면 1%p", () => {
  near(calcLoanLimit(biz({ rtiStress: 0.015 }), rules).rti.limit, 49.25e6 / 1.5 / 0.065);
  assert.equal(calcLoanLimit(biz({ rtiStress: 0.005 }), rules).rti.stress, 0.01);
});

test("임대사업자: 개인 전용 입력(신용대출·전세대출)은 경고·DSR에 쓰지 않음", () => {
  const r = calcLoanLimit(input({ region: "부산", use: "다가구주택", price: 10e8, borrower: "business", monthlyRent: 5e6, homes: "oneHome",
    creditLoanTotal: 2e8, jeonse: { has: true, inCapitalOrRegulated: true, policy: false, annualInterest: 1e7 } }), rules);
  assert.ok(!r.warnings.some((m) => m.includes("신용대출") || m.includes("전세대출")));
});

test("주택 임대사업자 수도권 금지 안내에 8·13 신축 비아파트 예외 포함", () => {
  const r = calcLoanLimit(input({ use: "연립·다세대", borrower: "business", monthlyRent: 3e6 }), rules);
  assert.ok(r.blocks.some((m) => m.includes("신축 비아파트")));
});

// ---- 투자 수익 분석 ----
const { investment } = require("../loanLimit.js");
const auctionBiz = () => biz({ price: 8e8, auctionRate: 0.554, deal: "auction", bid: 5.6e8, monthlyRent: 3.5e6, rentDeposit: 5e7 });

test("투자 분석: 자기자본 = 낙찰가 + 취득세 4.6% + 기타 비용 − 대출 − 보증금, 수익률 = (월세 − 이자) ÷ 자기자본", () => {
  const e = investment(auctionBiz(), rules, { otherCosts: 1e7 });
  assert.equal(e.loan, 3.82e8); // 담보 기준 한도가 결정
  near(e.tax, 25.76e6);
  near(e.equity, 5.6e8 + 25.76e6 + 1e7 - 3.82e8 - 5e7);
  near(e.net, 42e6 - 3.82e8 * 0.05);
  near(e.equityYield, e.net / e.equity, 1e-9);
});

test("투자 분석: 쓸 대출금을 정하면 한도 안에서 그 금액만", () => {
  assert.equal(investment(auctionBiz(), rules, { loanAmount: 3e8 }).loan, 3e8);
  assert.equal(investment(auctionBiz(), rules, { loanAmount: 9e8 }).loan, 3.82e8);
});

test("투자 분석: 목표 수익률의 최대 낙찰가에서 수익률이 목표와 같다", () => {
  const e = investment(auctionBiz(), rules, { otherCosts: 1e7, targetYield: 0.08 });
  assert.ok(e.maxBid > 5.6e8 && e.maxBid < 8e8);
  const at = investment({ ...auctionBiz(), bid: e.maxBid }, rules, { otherCosts: 1e7 });
  assert.ok(Math.abs(at.equityYield - 0.08) < 0.001, String(at.equityYield));
});

test("투자 분석: 순수익이 없으면(월세 0) 최대 낙찰가 0", () => {
  const e = investment({ ...auctionBiz(), monthlyRent: 0, rentDeposit: 0 }, rules, { targetYield: 0.05 });
  assert.equal(e.maxBid, 0);
});

// ---- 8·13 신축 비아파트, 주거용 오피스텔, 분할상환 현금흐름 ----
test("8·13 신축 비아파트: 규제지역 30%, 비규제 수도권 60%, 등록임대사업자 60%, 아파트는 해당 없음", () => {
  const base = { use: "연립·다세대", price: 5e8, borrower: "business", monthlyRent: 2e6, newBuild: true };
  const seoul = calcLoanLimit(input(base), rules);
  assert.equal(seoul.ltv.ratio, 0.30);
  assert.notEqual(seoul.binding, "blocked");
  assert.equal(calcLoanLimit(input({ ...base, region: "인천", depositTier: "dense" }), rules).ltv.ratio, 0.60);
  assert.equal(calcLoanLimit(input({ ...base, registeredLandlord: true }), rules).ltv.ratio, 0.60);
  assert.equal(calcLoanLimit(input({ ...base, use: "아파트" }), rules).binding, "blocked");
});

test("주거용 오피스텔 임대: RTI 1.25배, LTV는 비주택 그대로", () => {
  const r = calcLoanLimit(biz({ use: "오피스텔", residentialOfficetel: true }), rules);
  assert.equal(r.rti.threshold, 1.25);
  assert.equal(r.ltv.ratio, 0.70);
  assert.equal(calcLoanLimit(biz({ use: "오피스텔" }), rules).rti.threshold, 1.5);
});

test("투자 분석: 분할상환이면 연 원금 상환액 계산, 만기일시면 0", () => {
  const amort = investment({ ...auctionBiz(), repayment: "amortizing", years: 10 }, rules);
  near(amort.principal, annualPayment(amort.loan, 0.05, 10) - amort.loan * 0.05);
  assert.equal(investment({ ...auctionBiz(), repayment: "bullet" }, rules).principal, 0);
});
