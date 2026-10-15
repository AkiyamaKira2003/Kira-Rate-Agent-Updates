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

export function buildMarketPulse({ game, serverRows, listings, previousListings = null, recentEvents = [], completedSales = null, updatedAt = new Date().toISOString(), complete = true }) {
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

  for (const listing of listings) {
    const id = String(listing.id || "");
    const serverCode = String(listing.serverCode || "");
    if (!id || !serverMap.has(serverCode) || current.has(id)) continue;
    const amount = Number(listing.amount);
    const normalizedAmount = Number.isFinite(amount) && amount > 0 ? amount : null;
    current.set(id, { serverCode, amount: normalizedAmount, isOfflineSource: !!listing.isOfflineSource });
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
      listingEvent.removed.push({ id, serverCode: listing.serverCode, amount: Number(listing.amount) || 0 });
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
    const medSupply = median(servers.map((s) => s.listedAmount).filter((value) => value > 0)) || 1;
    const vanishRatio = servers.map((s) => s.disappearedAmount / (s.listedAmount + s.disappearedAmount + medSupply * .1));
    const ratioRanks = percentileRanks(vanishRatio);
    const volumeRanks = percentileRanks(servers.map((s) => Math.log1p(s.disappearedAmount)));
    const eventRanks = percentileRanks(servers.map((s) => Math.log1p(s.disappearedCount)));
    const activityExists = servers.some((s) => s.disappearedCount > 0);
    if (activityExists) {
      for (let i = 0; i < servers.length; i += 1) {
        servers[i].heatScore = Math.round((.45 * ratioRanks[i] + .40 * volumeRanks[i] + .15 * eventRanks[i]) * 1000) / 10;
        servers[i].heatMethod = "listing_activity_proxy";
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
    methodology: verifiedSalesAvailable ? "verified_sales" : "listing_activity_proxy",
    activityWindow: "7d",
    warning: verifiedSalesAvailable
      ? "Điểm nhiệt xếp hạng dựa trên lượng giao dịch được nhập có xác minh và nguồn cung niêm yết; không cam kết thời gian bán cụ thể."
      : "Heat Score sử dụng biến động tin niêm yết, không phải đơn bán xác minh. Khi chưa có biến động, thanh cung chỉ biểu thị lượng hàng rao bán, KHÔNG khẳng định server bán dễ hơn.",
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
