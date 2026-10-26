// 대출 한도 계산. 화면과 테스트가 함께 쓰는 순수 함수만 둔다. 규제 수치는 loanRules.js에서 받는다.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LoanLimit = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const LOCATION_NAMES = { regulated: "수도권·규제지역", unregulatedCapital: "비규제 수도권", local: "지방" };
  const HOMES_NAMES = { noHome: "무주택", conditional1Home: "처분조건부 1주택", oneHome: "1주택", multiHome: "다주택" };
  const PURPOSE_NAMES = { purchase: "주택구입", livingStability: "생활안정자금", relocation: "이주비" };

  function isRegulated(region, district, rules) {
    const area = rules.regulatedAreas[region];
    return area === "*" || (Array.isArray(area) && area.includes(district));
  }

  // 주택 소재지: regulated / unregulatedCapital / local
  function classifyLocation(region, district, rules) {
    if (isRegulated(region, district, rules)) return "regulated";
    return rules.capitalArea.includes(region) ? "unregulatedCapital" : "local";
  }

  function ltvRatio(input, location, rules) {
    const L = rules.ltv;
    if (!rules.housingUses.includes(input.use)) return { ratio: L.nonHousing, why: "비주택 담보" };
    const first = input.firstTimeBuyer && input.homes === "noHome" && input.purpose === "purchase";
    const name = LOCATION_NAMES[location];
    if (location === "local") {
      if (first) return { ratio: L.local.firstTimeBuyer, why: `${name} 생애최초 구입` };
      return { ratio: L.local.default, why: name };
    }
    // 규제지역과 비규제 수도권은 보유 주택 수·목적별 표를 쓴다
    const T = L[location];
    if (input.purpose !== "purchase") return { ratio: T.nonPurchase, why: `${name} ${PURPOSE_NAMES[input.purpose]}` };
    if (first) return { ratio: T.firstTimeBuyer, why: `${name} 생애최초 구입` };
    return { ratio: T[input.homes], why: `${name} ${HOMES_NAMES[input.homes]} 주택구입` };
  }

  // 가격 구간·목적별 금액 상한 (수도권 전체 + 규제지역). 해당 없으면 null.
  function amountCap(input, location, rules) {
    if (location === "local" || !rules.housingUses.includes(input.use)) return null;
    if (input.purpose === "relocation") return { cap: rules.relocationLoanCap, why: "이주비 대출 상한" };
    if (input.purpose === "livingStability") return { cap: rules.livingStabilityCap, why: "생활안정자금 상한" };
    if (input.purpose !== "purchase") return null;
    const tier = rules.mortgageCap_regulated_purchase.find((t) => t.maxPrice === null || input.price <= t.maxPrice);
    return { cap: tier.cap, why: tier.maxPrice === null ? "주택구입 가격 구간 상한 (최상위 구간)" : `주택구입 가격 구간 상한 (시가 ${tier.maxPrice / 1e8}억 이하)` };
  }

  function stressRate(input, location, rules) {
    let base = rules.stressRate[location];
    if (location === "local" && rules.stressRateFlags.localStage3Applied) base = rules.stressRate.localStage3;
    return base * (rules.stressRateTypeFactor[input.rateType] ?? 1);
  }

  // 원리금균등 연 상환액
  function annualPayment(principal, annualRate, years) {
    const n = years * 12, r = annualRate / 12;
    if (n <= 0) return Infinity;
    const monthly = r === 0 ? principal / n : principal * r / (1 - Math.pow(1 + r, -n));
    return monthly * 12;
  }

  // 연 상환 여력으로 빌릴 수 있는 원금 (annualPayment의 역함수)
  function principalFromAnnual(annual, annualRate, years) {
    const n = years * 12, r = annualRate / 12, monthly = annual / 12;
    if (annual <= 0 || n <= 0) return 0;
    return r === 0 ? monthly * n : monthly * (1 - Math.pow(1 + r, -n)) / r;
  }

  function smallDeposit(input, rules) {
    const tier = rules.smallDepositTiers.find((t) => t.id === input.depositTier) || rules.smallDepositTiers.at(-1);
    const raw = (input.houseUnits || 0) * tier.house + (input.shopUnits || 0) * tier.shop;
    return { tier, raw };
  }

  /**
   * input: { region, district, use, price, auctionRate(소수), ltvOverride(소수|null), homes, firstTimeBuyer, purpose,
   *   annualIncome, existingAnnualPayment, sector('bank'|'nonBank'), rateType, rate(소수), years, policyMortgage,
   *   creditLoanTotal, jeonse: { has, inCapitalOrRegulated, policy, annualInterest },
   *   depositTier, houseUnits, shopUnits }
   */
  function calcLoanLimit(input, rules) {
    const location = classifyLocation(input.region, input.district, rules);
    const housing = rules.housingUses.includes(input.use);
    const warnings = [];
    const blocks = [];

    // 1) 담보 기준 한도 = 시가 × min(낙찰가율, LTV) − 소액임차보증금
    const ltv = ltvRatio(input, location, rules);
    const ltvApplied = input.ltvOverride != null ? input.ltvOverride : ltv.ratio;
    const ratio = Math.min(input.auctionRate, ltvApplied);
    const expectedBid = input.price * input.auctionRate;
    const dep = smallDeposit(input, rules);
    const depositCap = expectedBid * rules.smallDepositCapRatio;
    const deduction = Math.min(dep.raw, depositCap);
    const collateralLimit = Math.max(0, input.price * ratio - deduction);

    // 2) 가격 구간·이주비 상한
    const cap = amountCap(input, location, rules);

    // 3) DSR 한도
    const jeonseInDsr = rules.jeonseInterestInDsrForOneHome && input.jeonse && input.jeonse.has &&
      input.jeonse.inCapitalOrRegulated && !input.jeonse.policy &&
      (input.homes === "oneHome" || input.homes === "conditional1Home");
    const existing = (input.existingAnnualPayment || 0) + (jeonseInDsr ? input.jeonse.annualInterest || 0 : 0);
    const stress = stressRate(input, location, rules);
    const dsrRatio = rules.dsrLimit[input.sector];
    let dsr;
    if (input.policyMortgage && rules.policyMortgageExcludedFromDSR) {
      dsr = { limit: null, excluded: true, why: "정책모기지는 DSR 계산 제외" };
    } else if (!input.annualIncome) {
      dsr = { limit: null, excluded: true, why: "연소득을 입력하면 DSR 한도를 계산합니다" };
    } else {
      const room = dsrRatio * input.annualIncome - existing;
      dsr = { limit: principalFromAnnual(room, input.rate + stress, input.years), excluded: false,
        why: `DSR ${dsrRatio * 100}% · 금리 ${(input.rate * 100).toFixed(2)}% + 스트레스 ${(stress * 100).toFixed(2)}%` };
    }

    // 4) 대출 불가·경고
    if (housing && location !== "local") {
      if (input.purpose === "purchase" && ltvApplied === 0 && input.ltvOverride == null)
        blocks.push(`${LOCATION_NAMES[location]} ${HOMES_NAMES[input.homes]} 차주의 주택구입 목적 대출은 불가합니다 (LTV 0%).`);
      if (input.purpose === "livingStability" && input.homes === "multiHome" && rules.livingStabilityMultiHomeBanned)
        blocks.push("수도권·규제지역 주택을 2채 이상 보유하면 생활안정자금 목적 주담대를 받을 수 없습니다.");
      if (location === "regulated" && input.purpose === "purchase" && rules.apartmentUses.includes(input.use) &&
        input.price > rules.jeonseLoanBlockApartmentPrice && input.jeonse && input.jeonse.has)
        blocks.push(`전세대출을 보유한 채 규제지역 ${rules.jeonseLoanBlockApartmentPrice / 1e8}억 초과 아파트를 구입하는 대출은 불가합니다.`);
    }
    if ((input.creditLoanTotal || 0) > rules.creditLoanWarnThreshold)
      warnings.push(`신용대출이 ${rules.creditLoanWarnThreshold / 1e8}억을 넘으면 신용대출 실행일부터 1년간 규제지역 주택 구입이 제한됩니다.`);
    if (jeonseInDsr) warnings.push(`1주택자의 수도권·규제지역 전세대출 이자(연 ${Math.round(input.jeonse.annualInterest || 0).toLocaleString("ko-KR")}원)를 DSR에 포함했습니다.`);
    if (dsr.limit !== null && dsr.limit <= 0) warnings.push("기존 대출 상환액만으로 DSR 한도를 넘어 추가 대출 여력이 없습니다.");

    // 5) 최종 한도와 결정 요인
    const candidates = [{ key: ratio < ltvApplied ? "auction" : "ltv", amount: collateralLimit }];
    if (cap) candidates.push({ key: "cap", amount: cap.cap });
    if (dsr.limit !== null) candidates.push({ key: "dsr", amount: Math.max(0, dsr.limit) });
    const binding = candidates.reduce((a, b) => (b.amount < a.amount ? b : a));
    const finalLimit = blocks.length ? 0 : binding.amount;

    return {
      location, locationName: LOCATION_NAMES[location], housing,
      ltv: { ratio: ltvApplied, policyRatio: ltv.ratio, why: ltv.why, overridden: input.ltvOverride != null },
      ratio, expectedBid,
      deposit: { tier: dep.tier, raw: dep.raw, cap: depositCap, deduction },
      collateralLimit, cap, dsr: { ...dsr, ratio: dsrRatio, stress, existingAnnual: existing, jeonseInDsr },
      binding: blocks.length ? "blocked" : binding.key, finalLimit, warnings, blocks,
    };
  }

  return { classifyLocation, ltvRatio, amountCap, stressRate, annualPayment, principalFromAnnual, calcLoanLimit,
    LOCATION_NAMES, HOMES_NAMES, PURPOSE_NAMES };
});
