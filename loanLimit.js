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

  // 임대사업자 사업자대출 LTV. 주택은 수도권·규제지역 금지(0%), 지방 60%. 비주택은 비주택담보대출 LTV를 쓴다.
  function businessLtvRatio(input, location, rules) {
    if (!rules.housingUses.includes(input.use)) {
      const l = ltvRatio(input, location, rules);
      return { ratio: l.ratio, why: `임대사업자 ${l.why}` };
    }
    if (location === "local") return { ratio: rules.business.housingLtvLocal, why: "지방 주택 임대·매매사업자" };
    return { ratio: 0, why: `${LOCATION_NAMES[location]} 주택 임대·매매사업자 (주택담보대출 금지)` };
  }

  // RTI 한도. 연 임대소득 ÷ RTI 기준 − 해당 건물 기존 대출 이자 = 이번 대출에 쓸 수 있는 연 이자.
  // 1억원 이하 대출은 RTI 심사 제외이므로 RTI 한도가 1억보다 작으면 1억까지는 가능하다.
  function rtiLimit(input, rules) {
    const B = rules.business;
    const housing = rules.housingUses.includes(input.use);
    const threshold = housing ? B.rti.housing : B.rti.nonHousing;
    const depositYield = input.depositYield ?? B.depositYield;
    const income = (input.monthlyRent || 0) * 12 + (input.rentDeposit || 0) * depositYield;
    const stress = input.rateType === "fixed" ? 0 : Math.max(B.rtiStressMin, input.rtiStress ?? 0);
    const existing = input.existingBuildingInterest || 0;
    const base = { threshold, income, stress, existing, depositYield };
    if (!input.monthlyRent && !input.rentDeposit) return { ...base, limit: null, excluded: true, why: "월세·보증금을 입력하면 RTI 한도를 계산합니다" };
    const rate = input.rate + stress;
    const room = income / threshold - existing;
    const byRti = room <= 0 ? 0 : rate > 0 ? room / rate : Infinity;
    const why = `RTI ${threshold}배 · 연 임대소득 ${Math.round(income / 1e4).toLocaleString("ko-KR")}만원 · 금리 ${(input.rate * 100).toFixed(2)}%` +
      (stress ? ` + 스트레스 ${(stress * 100).toFixed(2)}%` : " (고정금리)");
    if (byRti < B.rtiExemptAmount) return { ...base, limit: B.rtiExemptAmount, byRti, excluded: false, exempt: true,
      why: `RTI 기준 ${Math.round(byRti / 1e4).toLocaleString("ko-KR")}만원이지만 ${B.rtiExemptAmount / 1e8}억 이하 대출은 RTI 심사 제외` };
    return { ...base, limit: byRti, byRti, excluded: false, why };
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
   *   depositTier, houseUnits, shopUnits, seniorDebt(선순위 채권최고액, 경매면 인수할 금액),
   *   borrower('personal'|'business'), deal('market'|'auction'),
   *   경매: price=감정가, bid(낙찰가, 0이면 감정가 × 낙찰가율로 예상), bidRatio(낙찰가 인정 비율, 없으면 금융권별 기본값),
   *   임대사업자: monthlyRent, rentDeposit, depositYield, existingBuildingInterest(해당 건물 기존 대출 연 이자),
   *     rtiStress(변동금리 스트레스, 최소값보다 작으면 최소값) }
   */
  function calcLoanLimit(input, rules) {
    const location = classifyLocation(input.region, input.district, rules);
    const housing = rules.housingUses.includes(input.use);
    const business = input.borrower === "business";
    const warnings = [];
    const blocks = [];

    // 경매 낙찰: 담보가치 = min(감정가, 낙찰가). 낙찰가를 모르면 감정가 × 낙찰가율로 예상한다.
    let auction = null;
    if (input.deal === "auction") {
      const bidEstimated = !(input.bid > 0);
      const bid = bidEstimated ? input.price * input.auctionRate : input.bid;
      const bidRatio = input.bidRatio ?? rules.auctionLoan.bidRatio[input.sector];
      auction = { appraisal: input.price, bid, bidEstimated, bidRatio, value: Math.min(input.price, bid) };
      input = { ...input, price: auction.value }; // 가격 구간 상한 등은 담보가치로 판단
    }

    // 1) 담보 기준 한도 = 시가 × min(낙찰가율, LTV) − 소액임차보증금 − 선순위 채권
    //    경매는 min(담보가치 × LTV, 낙찰가 × 인정 비율) − 소액임차보증금 − 인수할 금액
    const policy = !business && input.policyProduct ? policyTerms(input, location, rules) : null;
    let ltv = business ? businessLtvRatio(input, location, rules) : ltvRatio(input, location, rules);
    // 정책모기지는 상품 LTV와 지역 규제 LTV 중 낮은 값 (보수적 가정)
    if (policy && policy.ltv < ltv.ratio) ltv = { ratio: policy.ltv, why: `${policy.name} 상품 기준` };
    const ltvApplied = input.ltvOverride != null ? input.ltvOverride : ltv.ratio;
    const ratio = auction ? ltvApplied : Math.min(input.auctionRate, ltvApplied);
    const expectedBid = auction ? auction.bid : input.price * input.auctionRate;
    const dep = smallDeposit(input, rules);
    const depositCap = expectedBid * rules.smallDepositCapRatio;
    const deduction = Math.min(dep.raw, depositCap);
    const seniorDebt = Math.max(0, input.seniorDebt || 0);
    if (auction) {
      auction.byLtv = auction.value * ltvApplied;
      auction.byBid = auction.bid * auction.bidRatio;
    }
    const gross = auction ? Math.min(auction.byLtv, auction.byBid) : input.price * ratio;
    const beforeSenior = Math.max(0, gross - deduction);
    const collateralLimit = Math.max(0, beforeSenior - seniorDebt);

    // 2) 가격 구간·이주비 상한
    // 정책모기지는 가격 구간 상한 대신 상품 자체 한도
    const cap = business ? null : policy ? { cap: policy.cap, why: `${policy.name} 자체 한도` } : amountCap(input, location, rules);

    // 3) DSR 한도
    const jeonseInDsr = !business && rules.jeonseInterestInDsrForOneHome && input.jeonse && input.jeonse.has &&
      input.jeonse.inCapitalOrRegulated && !input.jeonse.policy &&
      (input.homes === "oneHome" || input.homes === "conditional1Home");
    const existing = (input.existingAnnualPayment || 0) + (jeonseInDsr ? input.jeonse.annualInterest || 0 : 0);
    const stress = stressRate(input, location, rules);
    const dsrRatio = rules.dsrLimit[input.sector];
    let dsr;
    if (business) {
      dsr = { limit: null, excluded: true, why: "사업자대출은 DSR 계산에 들어가지 않습니다" };
    } else if ((input.policyMortgage || policy) && rules.policyMortgageExcludedFromDSR) {
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

    // 임대사업자는 DSR 대신 RTI
    const rti = business ? rtiLimit(input, rules) : null;

    // 4) 대출 불가·경고
    if (policy) { blocks.push(...policy.blocks); warnings.push(...policy.warnings); }
    if (business && housing && location !== "local" && input.ltvOverride == null)
      blocks.push(`${LOCATION_NAMES[location]}에서는 주택 매매·임대사업자의 주택담보대출이 금지됩니다 (2025.9.7 가계부채 보강안, LTV 0%). ` +
        "예외로 준공 1년 이내 신축 비아파트를 처음 사면 규제지역 30%·비규제 60%, 등록임대사업자는 60%까지 됩니다(2026.8.13 대책). 해당하면 'LTV 직접 입력'에 넣으세요.");
    if (business) {
      warnings.push("사업자대출은 DSR에 들어가지 않지만, 1억원 초과 대출은 LTI(전 금융권 대출 ÷ 소득)를 함께 심사하고 10억원 이상이면 심사의견을 반드시 남깁니다.");
      warnings.push("대출금은 임대업 용도로만 써야 합니다. 주택 구입 등 다른 용도로 쓰다 적발되면 대출이 회수되고 전 금융권 신규 대출이 1차 3년·2차 10년 제한됩니다 (2026 가계부채 관리방안).");
      if (!housing) warnings.push("사업자대출의 비주택 담보인정비율은 금융기관 내부 기준이라 다를 수 있습니다. 상담받은 비율이 있으면 'LTV 직접 입력'에 넣으세요.");
    }
    if (auction) {
      if (auction.bidEstimated) warnings.push(`낙찰가를 비워 감정가 × 낙찰가율 ${(input.auctionRate * 100).toFixed(1)}%로 예상했습니다. 낙찰받으면 실제 낙찰가를 넣으세요.`);
      else if (auction.bid > auction.appraisal) warnings.push("낙찰가가 감정가보다 높아 담보가치는 감정가로 봅니다.");
      warnings.push(`잔금은 매각허가결정 확정 후 보통 ${rules.auctionLoan.balanceDueMonths}개월 안에 내야 하고, 못 내면 입찰보증금을 잃습니다. 대출 상담은 입찰 전에 받아 두세요.`);
    }
    if (!business && housing && location !== "local") {
      if (input.purpose === "purchase" && ltvApplied === 0 && input.ltvOverride == null)
        blocks.push(`${LOCATION_NAMES[location]} ${HOMES_NAMES[input.homes]} 차주의 주택구입 목적 대출은 불가합니다 (LTV 0%).`);
      if (input.purpose === "livingStability" && input.homes === "multiHome" && rules.livingStabilityMultiHomeBanned)
        blocks.push("수도권·규제지역 주택을 2채 이상 보유하면 생활안정자금 목적 주담대를 받을 수 없습니다.");
      if (location === "regulated" && input.purpose === "purchase" && rules.apartmentUses.includes(input.use) &&
        input.price > rules.jeonseLoanBlockApartmentPrice && input.jeonse && input.jeonse.has)
        blocks.push(`전세대출을 보유한 채 규제지역 ${rules.jeonseLoanBlockApartmentPrice / 1e8}억 초과 아파트를 구입하는 대출은 불가합니다.`);
    }
    if (!business && housing && (input.creditLoanTotal || 0) > rules.creditLoanWarnThreshold)
      warnings.push(`신용대출이 ${rules.creditLoanWarnThreshold / 1e8}억을 넘으면 신용대출 실행일부터 1년간 규제지역 주택 구입이 제한됩니다.`);
    if (jeonseInDsr) warnings.push(`1주택자의 수도권·규제지역 전세대출 이자(연 ${Math.round(input.jeonse.annualInterest || 0).toLocaleString("ko-KR")}원)를 DSR에 포함했습니다.`);
    if (dsr.limit !== null && dsr.limit <= 0) warnings.push("기존 대출 상환액만으로 DSR 한도를 넘어 추가 대출 여력이 없습니다.");
    if (seniorDebt > 0 && seniorDebt >= beforeSenior) warnings.push("선순위 채권이 담보인정액 이상이라 이 담보로 추가 대출 여력이 없습니다.");

    // 5) 최종 한도와 결정 요인
    const collateralKey = auction ? (auction.byBid < auction.byLtv ? "bid" : "ltv") : ratio < ltvApplied ? "auction" : "ltv";
    const candidates = [{ key: collateralKey, amount: collateralLimit }];
    if (cap) candidates.push({ key: "cap", amount: cap.cap });
    if (dsr.limit !== null) candidates.push({ key: "dsr", amount: Math.max(0, dsr.limit) });
    if (rti && rti.limit !== null) candidates.push({ key: "rti", amount: Math.max(0, rti.limit) });
    const binding = candidates.reduce((a, b) => (b.amount < a.amount ? b : a));
    const finalLimit = blocks.length ? 0 : binding.amount;

    return {
      location, locationName: LOCATION_NAMES[location], housing, business, auction, rti,
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
    if (r.binding === "rti") return rtiSuggestions(input, r, rules);
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

  // RTI가 한도를 정했을 때: 담보 기준 한도까지 받으려면 필요한 월세, 고정금리로 바꿨을 때 한도
  function rtiSuggestions(input, r, rules) {
    const tips = [];
    const R = r.rti;
    const need = R.threshold * (r.collateralLimit * (input.rate + R.stress) + R.existing);
    const rent = (need - (input.rentDeposit || 0) * R.depositYield) / 12;
    if (rent > (input.monthlyRent || 0)) tips.push({ key: "rent", value: Math.ceil(rent / 1e4) * 1e4, amount: r.collateralLimit });
    if (R.stress > 0) {
      const amount = calcLoanLimit({ ...input, rateType: "fixed" }, rules).finalLimit;
      if (amount > r.finalLimit + 1) tips.push({ key: "fixed", value: null, amount });
    }
    return tips;
  }

  return { classifyLocation, businessLtvRatio, rtiLimit, ltvRatio, amountCap, stressRate, annualPayment, principalFromAnnual, dsrAnnualPayment, calcLoanLimit, suggestions,
    LOCATION_NAMES, HOMES_NAMES, PURPOSE_NAMES };
});
