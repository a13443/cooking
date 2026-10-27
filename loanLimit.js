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
    if (!rules.housingUses.includes(input.use)) return input.permitZone
      ? { ratio: L.nonHousingPermitZone, why: "토지거래허가구역(비주택 포함 지정) 비주택 담보" }
      : { ratio: L.nonHousing, why: "비주택 담보" };
    const first = input.firstTimeBuyer && input.homes === "noHome" && input.purpose === "purchase";
    const name = LOCATION_NAMES[location];
    if (location === "local") {
      if (first) return { ratio: L.local.firstTimeBuyer, why: `${name} 생애최초 구입` };
      if (input.homes === "multiHome" && input.purpose === "purchase") return { ratio: L.local.multiHome, why: `${name} 다주택 주택구입` };
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

  // 정책모기지 상품 요건 확인과 자체 한도·LTV. 일반·생애최초·가구 유형 중 해당하는 기준의 가장 너그러운 값을 쓴다.
  function policyTerms(input, location, rules) {
    const p = rules.policyProducts[input.policyProduct];
    const household = input.household || "general";
    const first = input.firstTimeBuyer && input.homes === "noHome";
    const keys = ["general", first && "firstTimeBuyer", household !== "general" && household].filter(Boolean);
    const best = (table) => Math.max(...keys.map((k) => table[k] ?? 0));
    const blocks = [], warnings = [];
    if (!rules.housingUses.includes(input.use) || input.purpose !== "purchase")
      blocks.push(`${p.name}은 주택구입 목적의 주택 담보에만 쓸 수 있습니다.`);
    if (!p.homes.includes(input.homes))
      blocks.push(`${p.name}은 ${p.homes.map((h) => HOMES_NAMES[h]).join("·")} 차주만 받을 수 있습니다.`);
    const maxPrice = p.maxPrice[household];
    if (input.price > maxPrice) blocks.push(`${p.name}은 주택가격 ${maxPrice / 1e8}억 이하만 대상입니다.`);
    const maxIncome = best(p.maxIncome);
    if (!input.annualIncome) warnings.push(`${p.name} 소득 요건(부부합산 연 ${maxIncome / 1e4}만원 이하)을 확인하려면 연소득을 입력하세요.`);
    else if (input.annualIncome > maxIncome) blocks.push(`${p.name} 소득 요건(부부합산 연 ${maxIncome / 1e4}만원 이하)을 넘습니다.`);
    const ltv = first ? (location === "local" ? p.ltv.firstTimeBuyer : p.ltv.firstTimeBuyerCapital) : p.ltv.general;
    return { name: p.name, cap: best(p.cap), ltv, blocks, warnings };
  }

  function stressRate(input, location, rules) {
    // 토지·상가 등 주택 외 담보대출은 '기타대출' 스트레스 금리를 지역과 관계없이 쓴다
    if (!rules.housingUses.includes(input.use)) return rules.stressRate.nonHousing * (rules.stressRateTypeFactor[input.rateType] ?? 1);
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

  // DSR 계산용 연 원리금. 만기일시상환은 원금 ÷ 간주 만기 + 연 이자, 그 밖에는 원리금균등.
  function dsrAnnualPayment(principal, input, stress, rules) {
    if (input.repayment === "bullet") return principal / rules.bulletDsrAssumedYears + principal * (input.rate + stress);
    return annualPayment(principal, input.rate + stress, input.years);
  }
  function dsrPrincipal(room, input, stress, rules) {
    if (room <= 0) return 0;
    if (input.repayment === "bullet") return room / (1 / rules.bulletDsrAssumedYears + input.rate + stress);
    return principalFromAnnual(room, input.rate + stress, input.years);
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
   *   annualIncome, existingAnnualPayment, sector('bank'|'nonBank'), rateType, rate(소수), years, policyMortgage(기타 정책모기지),
   *   policyProduct('didimdol'|'bogeumjari'|''), household('general'|'newlywed'|'multiChild'),
   *   creditLoanTotal, jeonse: { has, inCapitalOrRegulated, policy, annualInterest },
   *   depositTier, houseUnits, shopUnits, seniorDebt(선순위 채권최고액) }
   */
  function calcLoanLimit(input, rules) {
    const location = classifyLocation(input.region, input.district, rules);
    const housing = rules.housingUses.includes(input.use);
    const warnings = [];
    const blocks = [];

    // 1) 담보 기준 한도 = 시가 × min(낙찰가율, LTV) − 소액임차보증금 − 선순위 채권
    const policy = input.policyProduct ? policyTerms(input, location, rules) : null;
    let ltv = ltvRatio(input, location, rules);
    // 정책모기지는 상품 LTV와 지역 규제 LTV 중 낮은 값 (보수적 가정)
    if (policy && policy.ltv < ltv.ratio) ltv = { ratio: policy.ltv, why: `${policy.name} 상품 기준` };
    const ltvApplied = input.ltvOverride != null ? input.ltvOverride : ltv.ratio;
    const ratio = Math.min(input.auctionRate, ltvApplied);
    const expectedBid = input.price * input.auctionRate;
    const dep = smallDeposit(input, rules);
    const depositCap = expectedBid * rules.smallDepositCapRatio;
    const deduction = Math.min(dep.raw, depositCap);
    const seniorDebt = Math.max(0, input.seniorDebt || 0);
    const beforeSenior = Math.max(0, input.price * ratio - deduction);
    const collateralLimit = Math.max(0, beforeSenior - seniorDebt);

    // 2) 가격 구간·이주비 상한
    // 정책모기지는 가격 구간 상한 대신 상품 자체 한도
    const cap = policy ? { cap: policy.cap, why: `${policy.name} 자체 한도` } : amountCap(input, location, rules);

    // 3) DSR 한도
    const jeonseInDsr = rules.jeonseInterestInDsrForOneHome && input.jeonse && input.jeonse.has &&
      input.jeonse.inCapitalOrRegulated && !input.jeonse.policy &&
      (input.homes === "oneHome" || input.homes === "conditional1Home");
    const existing = (input.existingAnnualPayment || 0) + (jeonseInDsr ? input.jeonse.annualInterest || 0 : 0);
    const stress = stressRate(input, location, rules);
    const dsrRatio = rules.dsrLimit[input.sector];
    let dsr;
    if ((input.policyMortgage || policy) && rules.policyMortgageExcludedFromDSR) {
      dsr = { limit: null, excluded: true, why: "정책모기지는 DSR 계산 제외" };
    } else if (!input.annualIncome && !input.dsrExempt) {
      dsr = { limit: null, excluded: true, why: "연소득을 입력하면 DSR 한도를 계산합니다" };
    } else {
      const repay = input.repayment === "bullet" ? ` · 만기일시(원금 ÷ ${rules.bulletDsrAssumedYears}년)` : "";
      const byDsr = input.annualIncome ? dsrPrincipal(dsrRatio * input.annualIncome - existing, input, stress, rules) : 0;
      dsr = { limit: byDsr, excluded: false,
        why: `DSR ${dsrRatio * 100}% · 금리 ${(input.rate * 100).toFixed(2)}% + 스트레스 ${(stress * 100).toFixed(2)}%${repay}` };
      // 가계대출 총액이 기준 이하면 DSR이 적용되지 않으므로, 기준까지 남은 금액과 DSR 한도 중 큰 값
      if (input.dsrExempt) {
        const exemptRoom = Math.max(0, rules.dsrTotalLoanThreshold - (input.existingLoanBalance || 0));
        if (exemptRoom > byDsr) dsr = { limit: exemptRoom, excluded: false, exempt: true,
          why: `가계대출 총액 ${rules.dsrTotalLoanThreshold / 1e8}억 이하라 DSR 미적용 (기존 잔액 제외 ${Math.round(exemptRoom / 1e4).toLocaleString("ko-KR")}만원까지)` };
      }
    }

    // 4) 대출 불가·경고
    if (policy) { blocks.push(...policy.blocks); warnings.push(...policy.warnings); }
    if (housing && location !== "local") {
      if (input.purpose === "purchase" && ltvApplied === 0 && input.ltvOverride == null)
        blocks.push(`${LOCATION_NAMES[location]} ${HOMES_NAMES[input.homes]} 차주의 주택구입 목적 대출은 불가합니다 (LTV 0%).`);
      if (input.purpose === "livingStability" && input.homes === "multiHome" && rules.livingStabilityMultiHomeBanned)
        blocks.push("수도권·규제지역 주택을 2채 이상 보유하면 생활안정자금 목적 주담대를 받을 수 없습니다.");
      if (location === "regulated" && input.purpose === "purchase" && rules.apartmentUses.includes(input.use) &&
        input.price > rules.jeonseLoanBlockApartmentPrice && input.jeonse && input.jeonse.has)
        blocks.push(`전세대출을 보유한 채 규제지역 ${rules.jeonseLoanBlockApartmentPrice / 1e8}억 초과 아파트를 구입하는 대출은 불가합니다.`);
    }
    if (housing && (input.creditLoanTotal || 0) > rules.creditLoanWarnThreshold)
      warnings.push(`신용대출이 ${rules.creditLoanWarnThreshold / 1e8}억을 넘으면 신용대출 실행일부터 1년간 규제지역 주택 구입이 제한됩니다.`);
    if (jeonseInDsr) warnings.push(`1주택자의 수도권·규제지역 전세대출 이자(연 ${Math.round(input.jeonse.annualInterest || 0).toLocaleString("ko-KR")}원)를 DSR에 포함했습니다.`);
    if (dsr.limit !== null && dsr.limit <= 0) warnings.push("기존 대출 상환액만으로 DSR 한도를 넘어 추가 대출 여력이 없습니다.");
    if (seniorDebt > 0 && seniorDebt >= beforeSenior) warnings.push("선순위 채권이 담보인정액 이상이라 이 담보로 추가 대출 여력이 없습니다.");

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
      seniorDebt, collateralLimit, cap, dsr: { ...dsr, ratio: dsrRatio, stress, existingAnnual: existing, jeonseInDsr },
      binding: blocks.length ? "blocked" : binding.key, finalLimit, warnings, blocks,
    };
  }

  /**
   * DSR 때문에 한도가 정해졌을 때, 조건을 하나씩 바꾸면 한도가 얼마가 되는지 역산한다.
   * 반환: [{ key, value, amount }] — key: income(value=필요 연소득) / years(value=만기) / fixed / repayExisting / nonBank
   */
  function suggestions(input, rules) {
    const r = calcLoanLimit(input, rules);
    if (r.binding !== "dsr") return [];
    const tips = [];
    const ceiling = Math.min(r.collateralLimit, r.cap ? r.cap.cap : Infinity); // DSR을 빼고 남는 한도
    if (ceiling > r.finalLimit && input.years > 0) {
      const need = (dsrAnnualPayment(ceiling, input, r.dsr.stress, rules) + r.dsr.existingAnnual) / r.dsr.ratio;
      tips.push({ key: "income", value: Math.ceil(need / 1e4) * 1e4, amount: ceiling });
    }
    const alt = (key, value, over) => {
      const amount = calcLoanLimit({ ...input, ...over }, rules).finalLimit;
      if (amount > r.finalLimit + 1) tips.push({ key, value, amount });
    };
    if (input.years < rules.maxLoanYears) alt("years", rules.maxLoanYears, { years: rules.maxLoanYears });
    if (r.dsr.stress > 0) alt("fixed", null, { rateType: "fixed" });
    if (input.existingAnnualPayment > 0) alt("repayExisting", null, { existingAnnualPayment: 0 });
    if (input.sector === "bank") alt("nonBank", null, { sector: "nonBank" });
    return tips;
  }

  return { classifyLocation, ltvRatio, amountCap, stressRate, annualPayment, principalFromAnnual, dsrAnnualPayment, calcLoanLimit, suggestions,
    LOCATION_NAMES, HOMES_NAMES, PURPOSE_NAMES };
});
