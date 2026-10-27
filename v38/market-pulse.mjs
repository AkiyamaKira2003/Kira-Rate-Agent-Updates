// Market Pulse only ranks verified sales when a verified completed-trade feed exists.
// Disappeared listings are NOT completed sales (they can be withdrawn/edited).
export function percentileRanks(values) {
  return values.map((value) => {
    if (!Number.isFinite(value)) return null;
    const pool = values.filter(Number.isFinite);
    if (pool.length <= 1) return null;
    const below = pool.filter((v) => v < value).length;
    const equal = pool.filter((v) => v === value).length;
    return (below + (equal - 1) / 2) / (pool.length - 1);
  });
}

export function buildMarketPulse({ game, serverRows, listings, basisAmount = null, previousListings = null, recentEvents = [], completedSales = null, updatedAt = new Date().toISOString(), complete = true }) {
  const current = new Map();
  const serverMap = new Map(serverRows.map((server) => [server.serverCode, {
    serverCode: server.serverCode,
    serverName: server.serverNameKr || server.serverName,
    listedAmount: 0,
    listedCount: 0,
    totalListedAmount: 0,
    totalListedCount: 0,
    offlineListedAmount: 0,
    offlineListedCount: 0,
    amountUnknownCount: 0,
    supplyScore: null,
    supplyRank: null,
    newCount: null,
    newAmount: null,
    disappearedCount: null,
    disappearedAmount: null,
    verifiedSoldAmount: null,
    verifiedSoldCount: null,
    heatScore: null,
    heatRank: null,
    heatMethod: "pending",
  }]));

  // Quoted KRW is always per game.basisAmount, not necessarily the whole order.
  // A unit-priced listing may show 1K money while the seller's minimum
  // available order is 20K; use the seller's MINIMUM, never assume all stock
  // has changed hands. No raw KRW totals leave the Agent in market/heat.
  const perUnit = new Map(serverRows.map((server) => [server.serverCode, []]));
  for (const listing of listings) {
    const amount = Number(basisAmount);
    const price = Number(listing.priceKrw);
    if (Number.isFinite(amount) && amount > 0 && Number.isFinite(price) && price > 0 &&
      perUnit.has(String(listing.serverCode))) perUnit.get(String(listing.serverCode)).push(price / amount);
  }
  const globalRate = median([...perUnit.values()].flat()) || null;
  const serverRate = (code) => median(perUnit.get(code) || []) || globalRate;
  const positiveFinite = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 && n < 1e15 ? n : null;
  };
  const estimatedValue = (row, code, amount) => {
    const direct = positiveFinite(row?.valueKrw);
    if (direct) return direct;
    const price = positiveFinite(row?.priceKrw);
    const basis = positiveFinite(basisAmount);
    const rate = price && basis ? price / basis : serverRate(code);
    const value = positiveFinite(amount) && positiveFinite(rate) ? amount * rate : null;
    return positiveFinite(value);
  };
  const removedForValue = [];

  for (const listing of listings) {
    const id = String(listing.id || "");
    const serverCode = String(listing.serverCode || "");
    if (!id || !serverMap.has(serverCode) || current.has(id)) continue;
    const amount = positiveFinite(listing.amount);
    const minimum = positiveFinite(listing.minAvailableAmount);
    const normalizedAmount = minimum && amount ? Math.max(amount, minimum) : amount || minimum;
    const valueKrw = estimatedValue(listing, serverCode, normalizedAmount);
    current.set(id, { serverCode, amount: normalizedAmount, valueKrw, isOfflineSource: !!listing.isOfflineSource });
    const server = serverMap.get(serverCode);
    server.totalListedCount += 1;
    server.totalListedAmount += normalizedAmount || 0;
    if (listing.isOfflineSource) {
      server.offlineListedCount += 1;
      server.offlineListedAmount += normalizedAmount || 0;
      continue;
    }
    server.listedCount += 1;
    if (normalizedAmount === null) server.amountUnknownCount += 1;
    else server.listedAmount += normalizedAmount;
  }

  const hasBaseline = previousListings !== null && complete;
  const listingEvent = { at: updatedAt, added: [], removed: [] };
  if (hasBaseline) {
    for (const server of serverMap.values()) {
      server.newCount = 0;
      server.newAmount = 0;
      server.disappearedCount = 0;
      server.disappearedAmount = 0;
    }
    for (const [id, listing] of current) {
      if (Object.prototype.hasOwnProperty.call(previousListings, id)) continue;
      const server = serverMap.get(listing.serverCode);
      server.newCount += 1;
      server.newAmount += listing.amount || 0;
      listingEvent.added.push({ id, serverCode: listing.serverCode, amount: listing.amount || 0 });
    }
    for (const [id, listing] of Object.entries(previousListings)) {
      if (current.has(id)) continue;
      const server = serverMap.get(listing.serverCode);
      if (!server) continue;
      server.disappearedCount += 1;
      server.disappearedAmount += Number(listing.amount) || 0;
      const removed = { id, serverCode: listing.serverCode, amount: Number(listing.amount) || 0,
        valueKrw: positiveFinite(listing.valueKrw) };
      listingEvent.removed.push(removed);
      removedForValue.push(removed);
    }
    // The scores use a rolling 7-day window, not the arbitrary duration
    // between the two latest crawler runs.
    const cutoff = Date.parse(updatedAt) - 7 * 86400_000;
    for (const event of recentEvents) {
      if (!Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) < cutoff || Date.parse(event.at) > Date.parse(updatedAt)) continue;
      for (const listing of event.added || []) {
        const server = serverMap.get(listing.serverCode);
        if (!server) continue;
        server.newCount += 1;
        server.newAmount += Number(listing.amount) || 0;
      }
      for (const listing of event.removed || []) {
        const server = serverMap.get(listing.serverCode);
        if (!server) continue;
        server.disappearedCount += 1;
        server.disappearedAmount += Number(listing.amount) || 0;
        removedForValue.push(listing);
      }
    }
  }

  const servers = [...serverMap.values()];
  // Supply is useful on the very first scan, but it is NOT proof of demand.
  // Keep this separate from the activity/sales heat score at all times.
  if (servers.length > 1 && servers.some((s) => s.listedCount > 0)) {
    const countRanks = percentileRanks(servers.map((s) => Math.log1p(s.listedCount)));
    const amountRanks = percentileRanks(servers.map((s) => Math.log1p(s.listedAmount)));
    for (let i = 0; i < servers.length; i += 1) {
      servers[i].supplyScore = Math.round((.4 * countRanks[i] + .6 * amountRanks[i]) * 1000) / 10;
    }
    for (const s of servers) s.supplyRank = 1 + servers.filter((other) => other.supplyScore > s.supplyScore).length;
  }
  const verifiedSalesAvailable = Array.isArray(completedSales);
  if (verifiedSalesAvailable) {
    const seenTrades = new Set();
    const cutoff = Date.parse(updatedAt) - 7 * 86400_000;
    for (const trade of completedSales) {
      const id = String(trade?.id || "");
      const at = Date.parse(trade?.completedAt || "");
      const amount = Number(trade?.amount);
      if (!id || seenTrades.has(id) || !Number.isFinite(at) || at < cutoff || at > Date.parse(updatedAt)) continue;
      if (!Number.isFinite(amount) || amount <= 0 || !serverMap.has(trade.serverCode)) continue;
      seenTrades.add(id);
      const server = serverMap.get(trade.serverCode);
      server.verifiedSoldCount = (server.verifiedSoldCount ?? 0) + 1;
      server.verifiedSoldAmount = (server.verifiedSoldAmount ?? 0) + amount;
    }
    for (const server of servers) {
      server.verifiedSoldCount ??= 0;
      server.verifiedSoldAmount ??= 0;
    }
  }

  if (verifiedSalesAvailable && servers.length > 1 && servers.some((s) => s.verifiedSoldCount > 0)) {
    const medSupply = median(servers.map((s) => s.listedAmount).filter((value) => value > 0)) || 1;
    const ratios = servers.map((s) => s.verifiedSoldAmount / (s.verifiedSoldAmount + s.listedAmount + medSupply * .1));
    const volumeRanks = percentileRanks(servers.map((s) => Math.log1p(s.verifiedSoldAmount)));
    const ratioRanks = percentileRanks(ratios);
    const countRanks = percentileRanks(servers.map((s) => Math.log1p(s.verifiedSoldCount)));
    for (let i = 0; i < servers.length; i += 1) {
      servers[i].heatScore = Math.round((.5 * volumeRanks[i] + .35 * ratioRanks[i] + .15 * countRanks[i]) * 1000) / 10;
      servers[i].heatMethod = "verified_sales";
    }
  } else if (!verifiedSalesAvailable && hasBaseline && servers.length > 1) {
    const eventRanks = percentileRanks(servers.map((s) => Math.log1p(s.disappearedCount)));
    const activityExists = servers.some((s) => s.disappearedCount > 0);
    if (activityExists) {
      const valued = removedForValue
        .filter((listing) => serverMap.has(String(listing.serverCode)))
        .map((listing) => ({ serverCode: String(listing.serverCode), value: estimatedValue(
          listing, String(listing.serverCode), Number(listing.amount)) }))
        .filter((listing) => listing.value != null);
      // Clip individual unusually large orders: a single suspicious listing
      // disappearing should not overwhelm a week of ordinary activity.
      const medianValue = median(valued.map((listing) => listing.value)) || 0;
      const cap = medianValue > 0 ? medianValue * 6 : Infinity;
      const goneValue = new Map(servers.map((s) => [s.serverCode, 0]));
      for (const listing of valued) {
        goneValue.set(listing.serverCode, goneValue.get(listing.serverCode) + Math.min(listing.value, cap));
      }
      const listedValue = new Map(servers.map((s) => [s.serverCode, 0]));
      for (const listing of current.values()) {
        if (listing.isOfflineSource || !listedValue.has(listing.serverCode)) continue;
        const value = estimatedValue(listing, listing.serverCode, listing.amount);
        if (value) listedValue.set(listing.serverCode, listedValue.get(listing.serverCode) + value);
      }
      // Older persisted events predate the value field. Estimate those from
      // live per-server quotes; without such quotes retain the amount-based
      // proxy, rather than treating unknown values as zero sales.
      const valueCoverage = removedForValue.length > 0 ? valued.length / removedForValue.length : 0;
      const useValue = valueCoverage >= 0.5 && valued.length > 0;
      const gone = servers.map((s) => useValue ? goneValue.get(s.serverCode) : s.disappearedAmount);
      const available = servers.map((s) => useValue ? listedValue.get(s.serverCode) : s.listedAmount);
      const medianSupply = median(available.filter((value) => value > 0)) || 1;
      const turnover = gone.map((value, index) => value /
        (available[index] + value + medianSupply * .1));
      const ratioRanks = percentileRanks(turnover);
      const volumeRanks = percentileRanks(gone.map((value) => Math.log1p(value)));
      for (let i = 0; i < servers.length; i += 1) {
        // Estimated disappeared order value is the dominant signal (65%).
        // Turnover relative to supply matters (25%), while raw count has only
        // 10% influence. Ranks are relative WITHIN one game, not sale chances.
        servers[i].heatScore = Math.round((.65 * volumeRanks[i] + .25 * ratioRanks[i] + .10 * eventRanks[i]) * 1000) / 10;
        servers[i].heatMethod = useValue ? "listing_value_proxy" : "listing_activity_proxy";
      }
    }
  }
  for (const server of servers) {
    if (server.heatScore !== null) {
      server.heatRank = 1 + servers.filter((other) => other.heatScore !== null && other.heatScore > server.heatScore).length;
    }
  }

  return {
    ok: true,
    game,
    updatedAt,
    complete,
    hasBaseline,
    completedSales: {
      available: verifiedSalesAvailable,
      source: verifiedSalesAvailable ? "authorized_completed_sales_import" : null,
      note: verifiedSalesAvailable ? "Giao dịch được nhập từ nguồn đã được người vận hành xác minh." : "Chưa có nguồn giao dịch hoàn tất được xác minh.",
    },
    methodology: verifiedSalesAvailable ? "verified_sales" :
      servers.some((s) => s.heatMethod === "listing_value_proxy") ? "listing_value_proxy" : "listing_activity_proxy",
    activityWindow: "7d",
    warning: verifiedSalesAvailable
      ? "Điểm nhiệt xếp hạng dựa trên lượng giao dịch được nhập có xác minh và nguồn cung niêm yết; không cam kết thời gian bán cụ thể."
      : "Heat Score ước tính từ giá trị đơn rao bán không còn hiển thị (65%), tỷ lệ so với nguồn cung (25%) và số đơn biến mất (10%) trong 7 ngày; giá trị đơn bất thường được giới hạn. Đây KHÔNG phải doanh số bán được xác minh.",
    servers,
    listingIndex: Object.fromEntries(current),
    listingEvent: hasBaseline ? listingEvent : null,
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
// Read seller's stated quantities in Korean game-money units.
// Handles mixed text such as "74억5,310만 아데나" => 7,453,100,000.
// This is listing metadata, NOT a completed trade.
export function parseKoreanQuantity(text) {
  const input = String(text || "").replace(/,/g, "").replace(/\s+/g, "");
  if (!input) return null;
  const chunks = [...input.matchAll(/(\d+(?:\.\d+)?)(억|천만|만)/g)];
  if (!chunks.length) return null;
  // Thousands without an accompanying 억/만 may describe prices or counts.
  if (!chunks.some(([, , unit]) => unit === "억" || unit === "천만" || unit === "만")) return null;
  let result = 0;
  for (const [, raw, unit] of chunks) {
    const scale = unit === "억" ? 100_000_000 : unit === "천만" ? 10_000_000 : 10_000;
    result += Number(raw) * scale;
  }
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

// Seal M2 listings quote either a fixed number of game-money/diamonds or a
// price per 1,000 units. Barotem's single_unit is the authoritative pricing
// quantity; titles and min/max purchase quantities must not replace it.
// Korean mixed numerals such as "4만6,085 게임머니" mean 46,085, NOT 40,000.
export function parseSealM2Quantity(text) {
  const source = String(text || "").replace(/,/g, "").replace(/\s+/g, "");
  const prefix = source.split(/게임머니|다이아|다이야|Diamond/i)[0];
  if (!prefix || !/^\d/.test(prefix)) return null;
  const units = { 억: 100_000_000, 만: 10_000, 천: 1_000 };
  let tail = prefix;
  let amount = 0;
  for (const unit of ["억", "만", "천"]) {
    const matched = tail.match(new RegExp(`^(\\d+)${unit}`));
    if (!matched) continue;
    amount += Number(matched[1]) * units[unit];
    tail = tail.slice(matched[0].length);
  }
  if (tail && !/^\d+$/.test(tail)) return null;
  amount += tail ? Number(tail) : 0;
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

export function sealM2ListingQuote(row, basisAmount = 1_000) {
  const amount = parseSealM2Quantity(row?.single_unit);
  const totalKrw = Number(String(row?.baro_price || "").replace(/,/g, ""));
  if (!amount || !Number.isFinite(totalKrw) || totalKrw <= 0) return null;
  const priceKrw = Math.round(totalKrw * basisAmount / amount);
  if (!Number.isSafeInteger(priceKrw) || priceKrw <= 0) return null;
  const unitPriced = /천\s*게임머니|천\s*다이아/i.test(String(row?.saleUnitText || ""));
  const minAvailableAmount = unitPriced ? parseSealM2Quantity(row?.multi_minCnt) : null;
  const maxAvailableAmount = unitPriced ? parseSealM2Quantity(row?.multi_cnt) : null;
  return { amount, priceKrw, unitPriced,
    minAvailableAmount: minAvailableAmount && minAvailableAmount >= amount ? minAvailableAmount : null,
    maxAvailableAmount: maxAvailableAmount && maxAvailableAmount >= amount ? maxAvailableAmount : null };
}

// Shared pure orderbook aggregation, copied from Kira LC rate-depth.js for signed Agent releases.
// Pure rate-orderbook aggregation. This module reads the existing Rate Agent
// snapshot; it NEVER modifies Rate quotes or the Market Pulse / heatmap.

// RateNumber renders one decimal of 'k' (hundreds of VND).
// Several distinct KRW offers can therefore appear as the same VND rate.
export function displayVndRate(vnd) {
  return Math.round(vnd / 100) * 100;
}

export function formatWonGroup(minKrw, maxKrw) {
  if (!Number.isFinite(minKrw) || !Number.isFinite(maxKrw)) return null;
  const format = (value) => value.toLocaleString("vi-VN", { maximumFractionDigits: 2 });
  const difference = Math.round((maxKrw - minKrw) * 100) / 100;
  return difference > 0 ? `${format(minKrw)}+${format(difference)}` : format(minKrw);
}

// A marketplace listing may show the price of ONE 10K-Adena unit, while the
// seller offers 30M–100M Adena. In that case Agent's amount is the pricing
// unit (10K), NOT the total quantity. Prefer explicit title quantities,
// and never present unit size as the listing's entire stock.
export function listingQuantityForDepth(row, gameKey) {
  // From v32 Agent: read the seller's actual minimum/maximum quantity from
  // Barotem rather than interpreting a per-10K unit price as stock.
  const sellerMinimum = Number(row?.minAvailableAmount);
  const sellerMaximum = Number(row?.maxAvailableAmount);
  if ((gameKey === "lineageclassic" || gameKey === "mapleclassic" || gameKey === "sealm2") &&
    Number.isSafeInteger(sellerMinimum) && sellerMinimum > 0) {
    return {
      minimum: sellerMinimum,
      exact: Number.isSafeInteger(sellerMaximum) && sellerMaximum === sellerMinimum,
    };
  }
  const fallback = Number(row?.amount);
  const rawTitle = String(row?.title || "").replace(/(\d),(?=\d{3}\b)/g, "$1");
  if (gameKey === "lineageclassic" || gameKey === "mapleclassic") {
    const explicit = [...rawTitle.matchAll(/(\d+(?:\.\d+)?)\s*(억|만)/g)]
      .map((match) => Math.round(Number(match[1]) * (match[2] === "억" ? 100_000_000 : 10_000)))
      .filter((amount) => Number.isSafeInteger(amount) && amount > 0);
    if (explicit.length > 1) {
      return { minimum: Math.min(...explicit), exact: false };
    }
    if (explicit.length === 1) {
      const candidate = explicit[0];
      // A single explicit quantity matching the price-derived amount is an
      // actual fixed-size order, not a minimum/maximum inventory range.
      const exact = Number.isSafeInteger(fallback) && fallback > 0 &&
        Math.abs(fallback - candidate) / candidate < 0.03;
      return { minimum: candidate, exact };
    }
    // Some sellers write 3000-----10000 for 3000–10000 * 10K Adena.
    // Only interpret this format when clearly labeled as Adena units.
    if (/아데나/i.test(rawTitle) && /만/.test(String(row?.unitPrice || ""))) {
      const range = rawTitle.match(/(?:^|[^\d])([1-9]\d{2,5})\s*[-~–—_]{2,}\s*([1-9]\d{2,5})(?!\d)/);
      if (range && Number(range[2]) >= Number(range[1])) {
        const minimum = Number(range[1]) * 10_000;
        if (Number.isSafeInteger(minimum)) return { minimum, exact: false };
      }
    }
    const unitOnly = /만/.test(String(row?.unitPrice || "")) &&
      /1\s*만/.test(String(row?.singleUnit || "")) &&
      Number(row?.baroPrice) > 0 && Number(row?.priceKrw) > 0 &&
      Number(row.baroPrice) <= Number(row.priceKrw) * 1.02 &&
      fallback <= 10_000;
    if (unitOnly) return { minimum: null, exact: false };
  }
  return Number.isSafeInteger(fallback) && fallback > 0
    ? { minimum: fallback, exact: true }
    : { minimum: null, exact: false };
}

function listingQuantityMaximumForDepth(row, gameKey, quantity) {
  if (quantity.exact) return quantity.minimum;
  if (gameKey !== "lineageclassic" && gameKey !== "mapleclassic" && gameKey !== "sealm2") return null;
  const sellerMaximum = Number(row?.maxAvailableAmount);
  if (Number.isSafeInteger(sellerMaximum) && sellerMaximum >= (quantity.minimum ?? 1)) {
    return sellerMaximum;
  }
  const title = String(row?.title || "").replace(/(\d),(?=\d{3}\b)/g, "$1");
  const written = [...title.matchAll(/(\d+(?:\.\d+)?)\s*(억|만)/g)]
    .map((match) => Math.round(Number(match[1]) * (match[2] === "억" ? 100_000_000 : 10_000)))
    .filter((amount) => Number.isSafeInteger(amount) && amount > 0);
  if (written.length > 1) return Math.max(...written);
  if (/아데나/i.test(title) && /만/.test(String(row?.unitPrice || ""))) {
    const range = title.match(/(?:^|[^\d])([1-9]\d{2,5})\s*[-~–—_]{2,}\s*([1-9]\d{2,5})(?!\d)/);
    if (range && Number(range[2]) >= Number(range[1])) return Number(range[2]) * 10_000;
  }
  return null;
}

export function buildRateDepth({
  gameKey,
  snapshot,
  serverCode,
  tier,
  quoteVnd,
  fxRate,
  deductionPercent,
  smallTierSpreadPercent,
  sourceBasisKrw = null,
  owner = false,
}) {
  const server = (snapshot?.rows || []).find((row) => String(row.serverCode) === serverCode);
  const sourceRows = snapshot?.byServer?.[serverCode] || (snapshot?.products || []).filter((row) => row.serverCode === serverCode);
  const offlineFallback = server?.quoteStatus === "offline";
  const seen = new Set();
  const buckets = new Map();
  let listingCount = 0;
  let matchedRateSource = false;
  for (const row of sourceRows || []) {
    if (!row) continue;
    // Both displayed tiers derive from ONE rate baseline in toPublicRow().
    // Never filter the underlying market offers by sizeGroup for one tier
    // and not the other. That discarded the quote's own source listing.
    // Offline offers cannot be used to undercut an online quote. The Dokkaebi
    // offline fallback is explicitly marked when no online quote exists.
    if (!!row.isOfflineSource !== offlineFallback) continue;
    const id = String(row.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const sourceListing = !!server?.source?.id && id === String(server.source.id);
    const krw = Number(sourceListing && Number(sourceBasisKrw) > 0 ? sourceBasisKrw : row.priceKrw);
    if (!Number.isFinite(krw) || krw <= 0) continue;
    if (sourceListing) matchedRateSource = true;
    const base = Math.round(krw * fxRate * (1 - deductionPercent / 100));
    const vnd = tier === "small"
      ? Math.round(base * (1 - smallTierSpreadPercent / 100))
      : base;
    if (!Number.isFinite(vnd) || vnd <= 0) continue;
    listingCount += 1;
    const displayVnd = displayVndRate(vnd);
    const existing = buckets.get(displayVnd) || {
      vnd: displayVnd,
      count: 0,
      totalAmount: 0,
      amountKnownCount: 0,
      minKrw: krw,
      maxKrw: krw,
      orders: [],
    };
    existing.count += 1;
    // Each Barotem listing has its own game-money quantity (Adena, Meso,
    // Diamond...). Aggregate raw units only, never KRW/VND listing values.
    // Missing or zero quantity means unknown; it is NOT a zero-quantity order.
    const quantity = listingQuantityForDepth(row, gameKey);
    const maximum = listingQuantityMaximumForDepth(row, gameKey, quantity);
    existing.orders.push({
      id,
      amount: quantity.minimum,
      maxAmount: maximum,
      exact: quantity.exact,
      vnd: displayVnd,
      ...(owner ? { priceKrw: krw } : {}),
    });
    if (quantity.minimum !== null && Number.isSafeInteger(existing.totalAmount + quantity.minimum)) {
      existing.totalAmount += quantity.minimum;
      existing.amountKnownCount += 1;
    }
    if (!quantity.exact) existing.estimatedAmountCount = (existing.estimatedAmountCount || 0) + 1;
    existing.minKrw = Math.min(existing.minKrw, krw);
    existing.maxKrw = Math.max(existing.maxKrw, krw);
    buckets.set(displayVnd, existing);
  }
  const quote = quoteVnd != null && Number.isFinite(Number(quoteVnd)) && Number(quoteVnd) > 0
    ? displayVndRate(Number(quoteVnd)) : null;
  const ordered = [...buckets.values()].sort((a, b) => a.vnd - b.vnd);
  const cheaper = quote == null ? [] : ordered.filter((row) => row.vnd < quote);
  const current = quote == null ? null : buckets.get(quote);
  // No bucket does NOT prove there are zero offers. For some legacy Agent
  // snapshots, the quote source is absent/incomplete. Do not invent a zero.
  const currentCount = quote == null ? null : current?.count ?? null;
  const above = quote == null ? ordered : ordered.filter((row) => row.vnd > quote);
  const levels = [
    ...(quote == null ? [] : [current || { vnd: quote, count: null, totalAmount: null, amountKnownCount: 0, minKrw: null, maxKrw: null, orders: [] }]),
    ...above,
  ].slice(0, 5).map((row) => ({
    vnd: row.vnd,
    count: row.count,
    totalAmount: row.amountKnownCount > 0 ? row.totalAmount : null,
    amountIncomplete: row.count != null && (
      row.amountKnownCount < row.count || (row.estimatedAmountCount || 0) > 0
    ),
    isCurrent: quote !== null && row.vnd === quote,
    isUnmatched: row.count == null,
    // Already included in the Rate snapshot: the client needs no extra
    // request when a buyer hovers over a grouped amount or order count.
    // Never expose the marketplace listing ID in a public Rate payload.
    // Hiding links in React alone is insufficient: users can inspect JSON.
    orders: [...row.orders]
      .sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1) || a.id.localeCompare(b.id))
      .map((order) => ({
        amount: order.amount,
        maxAmount: order.maxAmount,
        exact: order.exact,
        vnd: order.vnd,
        ...(owner ? { id: order.id, priceKrw: order.priceKrw } : {}),
      })),
    ...(owner ? {
      minKrw: row.minKrw,
      maxKrw: row.maxKrw,
      wonLabel: formatWonGroup(row.minKrw, row.maxKrw),
    } : {}),
  }));
  return {
    ok: true,
    game: gameKey,
    serverCode,
    tier,
    quoteVnd: quote,
    updatedAt: snapshot?.updatedAt || null,
    stale: !!snapshot?.isStale,
    listingScope: offlineFallback ? "offline_fallback" : "online",
    listingCount,
    distinctRateCount: ordered.length,
    currentCount,
    sourceMatched: matchedRateSource,
    cheaperCount: cheaper.reduce((sum, row) => sum + row.count, 0),
    higherCount: above.reduce((sum, row) => sum + row.count, 0),
    hasMoreHigher: above.length > (quote === null ? 5 : 4),
    levels,
    ...(owner ? { sourceKrw: Number(server?.source?.priceKrw) || null } : {}),
  };
}
// The public quote calculation is identical to the old edge Worker logic.
// Keep this in the signed Agent package so the expensive snapshot stays local.
export function publicQuoteBasisKrw(gameKey, row) {
  const positive = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  const small = positive(row.small?.priceKrw ?? row.ratePerBasisKrwLt1m);
  const large = positive(row.large?.priceKrw ?? row.ratePerBasisKrwGt1m);
  const fast = positive(row.fast?.priceKrw ?? row.ratePerBasisKrwFast ?? small ?? large);
  const base = large ?? small ?? fast;
  if (!["solenchant", "zeus", "eclipse", "dokkaebi"].includes(gameKey) || !(base > 0)) return base;
  const source = row?.source;
  const amount = Number(source?.amount);
  const sourceKrw = Number(source?.priceKrw);
  const match = String(source?.title || "").match(/^\s*([\d,]+)\s*(?:다이아|다이야|게임머니|금전)/u);
  if (!match || !(amount > 0) || !(sourceKrw > 0) || sourceKrw !== base) return base;
  const statedAmount = Number(match[1].replace(/,/g, ""));
  if (!(statedAmount > 0) || amount / statedAmount < 2) return base;
  const adjusted = Math.round(sourceKrw * amount / statedAmount);
  return adjusted > 0 && adjusted < 200000 ? adjusted : base;
}
