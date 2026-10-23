import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { buildMarketPulse, parseKoreanQuantity, sealM2ListingQuote, buildRateDepth, publicQuoteBasisKrw } from "./market-pulse.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentStartedAt = Date.now();
const DATA_DIR = path.join(__dirname, "data");
const LOG_DIR = path.join(__dirname, "logs");
const AGENT_VERSION = "2026-10-23.36-sealm2-rates";

const env = await loadEnv(path.join(__dirname, ".env"));
const PORT = Number(env.PORT || 8788);
const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "https://kiralc.io.vn";
const SECRET = env.RATE_COLLECTOR_SECRET || "";
// Independent token for remote owner-triggered update checks. Not a rate/admin credential.
const UPDATE_CONTROL_SECRET = env.UPDATE_CONTROL_SECRET || "";
const POLL_INTERVAL_MS = Number(env.POLL_INTERVAL_MS || 60000);
const FETCH_TIMEOUT_MS = Number(env.FETCH_TIMEOUT_MS || 15000);
const FETCH_RETRIES = Number(env.FETCH_RETRIES || 2);
const BAROTEM_SOURCE_SPACING_MS = Number(env.BAROTEM_SOURCE_SPACING_MS || 180);
const HISTORY_MIN_INTERVAL_MS = Number(env.HISTORY_MIN_INTERVAL_MS || 60000);
const HISTORY_RETENTION_DAYS = Number(env.HISTORY_RETENTION_DAYS || 30);
const HISTORY_PRUNE_INTERVAL_MS = Number(env.HISTORY_PRUNE_INTERVAL_MS || 60 * 60 * 1000);
const STALE_AFTER_MS = Number(env.STALE_AFTER_MS || 180000);
const BAROTEM_BASE = env.BAROTEM_BASE || "https://www.barotem.com";
const BAROTEM_ONLINE_MAX_AGE_MS = Number(env.BAROTEM_ONLINE_MAX_AGE_MS || 60 * 60 * 1000);
const LOW_OUTLIER_SAMPLE_SIZE = Number(env.LOW_OUTLIER_SAMPLE_SIZE || 10);
const LOW_OUTLIER_KEEP_RATIO = Number(env.LOW_OUTLIER_KEEP_RATIO || 0.55);
const SERVER_DISCOVERY_INTERVAL_MS = Number(env.SERVER_DISCOVERY_INTERVAL_MS || 6 * 60 * 60 * 1000);
const SERVER_DISCOVERY_PROBE_SPACING_MS = Number(env.SERVER_DISCOVERY_PROBE_SPACING_MS || 180);
const SERVER_REGISTRY_FILE = "server-registry.json";
const GAMEBIT_CHART_URL = env.GAMEBIT_CHART_URL || "https://gamebit.co.kr/v3_get_chart_data.php";
const CHART_CACHE_TTL_MS = Number(env.CHART_CACHE_TTL_MS || 5 * 60 * 1000);
const MARKET_CACHE_TTL_MS = Number(env.MARKET_CACHE_TTL_MS || 5 * 60 * 1000);
const MARKET_POLL_INTERVAL_MS = Number(env.MARKET_POLL_INTERVAL_MS || 20 * 60 * 1000);
const MARKET_BOOT_DELAY_MS = Number(env.MARKET_BOOT_DELAY_MS ?? 60_000);
const MARKET_MAX_PAGES_PER_SERVER = Number(env.MARKET_MAX_PAGES_PER_SERVER || 12);
const MARKET_PAGE_SIZE = 60;
const MARKET_SOURCE_SPACING_MS = Number(env.MARKET_SOURCE_SPACING_MS || 180);
const VERIFIED_SALES_IMPORT_ENABLED = env.VERIFIED_SALES_IMPORT_ENABLED === "1";
const UPDATE_ENABLED = env.UPDATE_ENABLED === "1";
const UPDATE_POLL_INTERVAL_MS = Math.max(60 * 60 * 1000, Number(env.UPDATE_POLL_INTERVAL_MS || 6 * 60 * 60 * 1000));
const CHART_MAX_POINTS = {
  "24h": Number(env.CHART_MAX_POINTS_24H || 520),
  "7d": Number(env.CHART_MAX_POINTS_7D || 900),
  "30d": Number(env.CHART_MAX_POINTS_30D || 900),
};
const GAMEBIT_TOTAL_STATUS_URLS = [
  "https://gamebit.co.kr/jdata2/total_status.json",
  "https://gamebit.co.kr/jdata/total_status.json",
];
const GAMEBIT_EXTRA_STATUS_URLS = [
  "https://gamebit.co.kr/jdata2/mapleworld/total_status.json",
  "https://gamebit.co.kr/jdata2/solenchant/total_status.json",
];

const RANGE_CONFIG = {
  "24h": { gamebitType: "min", windowMs: 24 * 60 * 60 * 1000 },
  "7d": { gamebitType: "min", windowMs: 7 * 24 * 60 * 60 * 1000 },
  "30d": { gamebitType: "day", windowMs: 30 * 24 * 60 * 60 * 1000 },
};

const GAMES = [
  {
    key: "lineageclassic",
    code: "LINEAGE_CLASSIC",
    name: "Lineage Classic",
    currencyName: "Adena",
    unitLabel: "10K Adena",
    categoryId: "2382r902",
    autoDiscoverServers: true,
    rowKeyword: "",
    basisAmount: 10_000,
    minRateKrw: 200,
    maxRateKrw: 5_000,
    serverOpt1s: ["24487","24488","24489","24490","24491","24492","24493","24494","24495","24496","24527","24528","24529","24530","24531","24575","24576","24577","24578","24579","24609","24610","24611","24612","24613","25273","25274","26022","26641","27413","27455","28563"],
    serverNames: ["데포로쥬","켄라우헬","질리언","이실로테","조우","하딘","케레니스","오웬","크리스터","아인하사드","아툰","가드리아","군터","아스테어","듀크데필","발센","어레인","캐스톨","세바스챤","데컨","파아그리오","에바","사이하","마프르","린델","하이네","로엔그린","발라카스","오렌","안타라스","글루디오","아덴"],
    splitLabelSmall: "< 1M Adena",
    splitLabelLarge: ">= 1M Adena",
    splitAmount: 1_000_000,
  },
  {
    key: "maplestoryworld",
    code: "MAPLESTORY_WORLD",
    name: "MapleStory World",
    currencyName: "Meso",
    unitLabel: "1M Meso",
    categoryId: "2382r977",
    autoDiscoverServers: false,
    rowKeyword: "",
    basisAmount: 1_000_000,
    minRateKrw: 50,
    lowOutlierSampleSize: 10,
    lowOutlierKeepRatio: 0.55,
    maxRateKrw: 100_000,
    gamebitPriceDivisor: 100,
    serverOpt1s: ["26192"],
    serverNames: ["메이플 플래닛"],
    splitLabelSmall: "< 100M Meso",
    splitLabelLarge: ">= 100M Meso",
    splitAmount: 100_000_000,
  },
  {
    key: "sealm2",
    code: "SEAL_M2",
    name: "Seal M2",
    currencyName: "Diamond",
    unitLabel: "1K Diamond",
    categoryId: "2382r1106",
    autoDiscoverServers: true,
    rowKeyword: "",
    basisAmount: 1_000,
    deriveKrwFromAmount: true,
    minRateKrw: 1_000,
    maxRateKrw: 25_000,
    lowOutlierSampleSize: 10,
    lowOutlierKeepRatio: 0.55,
    serverOpt1s: ["29081","29081","29081","29081","29081","30160","30160","30160","30160","30160"],
    serverOpt3s: ["30156","30157","30158","30159","30260","30156","30157","30158","30159","30260"],
    serverNames: ["엘림 1","엘림 2","엘림 3","엘림 4","엘림 5","라임 1","라임 2","라임 3","라임 4","라임 5"],
    splitLabelSmall: "< 10K Diamond",
    splitLabelLarge: ">= 10K Diamond",
    splitAmount: 10_000,
  },
  {
    key: "solenchant",
    code: "SOL_ENCHANT",
    name: "SOL Enchant",
    currencyName: "Diamond",
    unitLabel: "1K Diamond",
    categoryId: "2382r1003",
    autoDiscoverServers: true,
    rowKeyword: "",
    basisAmount: 1_000,
    minRateKrw: 2_000,
    maxRateKrw: 100_000,
    serverOpt1s: ["26754","26754","26754","26754","26754","26755","26755","26755","26755","26755","26756","26756","26756","26756","26756","26757","26757","26757","26757","26757","26758","26758","26758","26758","26758","26759","26759","26759","26759","26759","27059","27059","27059","27059","27059"],
    serverOpt3s: ["26749","26750","26751","26752","26753","26749","26750","26751","26752","26753","26749","26750","26751","26752","26753","26749","26750","26751","26752","26753","26749","26750","26751","26752","26753","26749","26750","26751","26752","26753","26749","26750","26751","26752","26753"],
    serverNames: ["칼테온 01","칼테온 02","칼테온 03","칼테온 04","칼테온 05","린델 01","린델 02","린델 03","린델 04","린델 05","이브라스 01","이브라스 02","이브라스 03","이브라스 04","이브라스 05","헬론드 01","헬론드 02","헬론드 03","헬론드 04","헬론드 05","에르네 01","에르네 02","에르네 03","에르네 04","에르네 05","리차드 01","리차드 02","리차드 03","리차드 04","리차드 05","레지나 01","레지나 02","레지나 03","레지나 04","레지나 05"],
    splitLabelSmall: "< 10K Diamond",
    splitLabelLarge: ">= 10K Diamond",
    splitAmount: 10_000,
  },
  {
    key: "zeus",
    code: "ZEUS",
    name: "Zeus",
    currencyName: "Diamond",
    unitLabel: "1K Diamond",
    categoryId: "2382r1057",
    autoDiscoverServers: true,
    rowKeyword: "",
    basisAmount: 1_000,
    gamebitPriceDivisor: 10,
    deriveKrwFromAmount: true,
    minRateKrw: 1_000,
    maxRateKrw: 50_000,
    serverOpt1s: ["27916","27916","27916","27938","27938","27938","27939","27939","27939","27940","27940","27940","27941","27941","27941","27942","27942","27942","27943","27943","27943","27944","27944","27944","27945","27945","27945","27946","27946","27946","28412","28412","28412","28635","28635","28635","28636","28636","28636"],
    serverOpt3s: ["27947","27948","27949","27947","27948","27949","27947","27948","27949","27947","27948","27949","27947","27948","27949","27947","27948","27949","27947","27948","27949","27947","27948","27949","27947","27948","27949","27947","27948","27949","27947","27948","27949","27947","27948","27949","27947","27948","27949"],
    serverNames: ["아테나 1","아테나 2","아테나 3","아레스 1","아레스 2","아레스 3","제우스 1","제우스 2","제우스 3","헤라 1","헤라 2","헤라 3","포세이돈 1","포세이돈 2","포세이돈 3","아폴론 1","아폴론 2","아폴론 3","아르테미스 1","아르테미스 2","아르테미스 3","아프로디테 1","아프로디테 2","아프로디테 3","헤파이스토스 1","헤파이스토스 2","헤파이스토스 3","헤르메스 1","헤르메스 2","헤르메스 3","데메테르 1","데메테르 2","데메테르 3","디오니소스 1","디오니소스 2","디오니소스 3","하데스 1","하데스 2","하데스 3"],
    splitLabelSmall: "< 10K Diamond",
    splitLabelLarge: ">= 10K Diamond",
    splitAmount: 10_000,
  },
  {
    key: "eclipse",
    code: "ECLIPSE",
    name: "Eclipse: The Awakening",
    currencyName: "Diamond",
    unitLabel: "1K Diamond",
    categoryId: "2382r1058",
    autoDiscoverServers: true,
    rowKeyword: "",
    basisAmount: 1_000,
    deriveKrwFromAmount: true,
    minRateKrw: 1_000,
    maxRateKrw: 50_000,
    lowOutlierSampleSize: 10,
    lowOutlierKeepRatio: 0.55,
    discoveryOpt3AllowByOpt1: {
      "29139": ["28078", "28079", "28080"],
    },
    serverOpt1s: ["28084","28084","28084","28084","28084","28084","28085","28085","28085","28085","28085","28085","28086","28086","28086","28086","28086","28086","28087","28087","28087","28087","28087","28087","28088","28088","28088","28088","28088","28088"],
    serverOpt3s: ["28078","28079","28080","28081","28082","28083","28078","28079","28080","28081","28082","28083","28078","28079","28080","28081","28082","28083","28078","28079","28080","28081","28082","28083","28078","28079","28080","28081","28082","28083"],
    serverNames: ["헤스카리온 01","헤스카리온 02","헤스카리온 03","헤스카리온 04","헤스카리온 05","헤스카리온 06","바르카디온 01","바르카디온 02","바르카디온 03","바르카디온 04","바르카디온 05","바르카디온 06","발키리아 01","발키리아 02","발키리아 03","발키리아 04","발키리아 05","발키리아 06","세라하 01","세라하 02","세라하 03","세라하 04","세라하 05","세라하 06","벨제라 01","벨제라 02","벨제라 03","벨제라 04","벨제라 05","벨제라 06"],
    splitLabelSmall: "< 10K Diamond",
    splitLabelLarge: ">= 10K Diamond",
    splitAmount: 10_000,
  },
  {
    key: "dokkaebi",
    code: "DOKKAEBI_WORLD",
    name: "Dokkaebi World",
    currencyName: "Game Money",
    unitLabel: "1K Game Money",
    categoryId: "2382r1093",
    autoDiscoverServers: true,
    detailOption: "opt2",
    rowKeyword: "",
    basisAmount: 1_000,
    deriveKrwFromAmount: true,
    minRateKrw: 1_000,
    maxRateKrw: 200_000,
    lowOutlierSampleSize: 10,
    lowOutlierKeepRatio: 0.55,
    serverOpt1s: ["28830","28830","28830","28831","28831","28831","28832","28832","28832","28833","28833","28833","28834","28834","28834","28835","28835","28835","28836","28836","28836","28837","28837","28837","28838","28838","28838","29009","29009","29009","29863","29863","29863","29866","29866","29866","29871","29871","29871"],
    serverOpt3s: ["28839","28840","28841","28839","28840","28841","28839","28840","28841","28839","28840","28841","28839","28840","28841","28839","28840","28841","28839","28840","28841","28839","28840","28841","28839","28840","28841","28839","28840","28841","28839","28840","28841","28839","28840","28841","28839","28840","28841"],
    serverNames: ["몽련 1","몽련 2","몽련 3","해월 1","해월 2","해월 3","괴량 1","괴량 2","괴량 3","아산 1","아산 2","아산 3","공월아 1","공월아 2","공월아 3","홍미희 1","홍미희 2","홍미희 3","강이태 1","강이태 2","강이태 3","소운 1","소운 2","소운 3","무이 1","무이 2","무이 3","묘롱 1","묘롱 2","묘롱 3","해일 1","해일 2","해일 3","백운 1","백운 2","백운 3","비영 1","비영 2","비영 3"],
    splitLabelSmall: "< 10K Game Money",
    splitLabelLarge: ">= 10K Game Money",
    splitAmount: 10_000,
  },
].filter((game) => !env.TEST_GAME_KEYS || env.TEST_GAME_KEYS.split(",").map((key) => key.trim()).includes(game.key));

let state = {
  bootedAt: new Date().toISOString(),
  updatedAt: null,
  status: "booting",
  consecutiveFailures: 0,
  lastError: null,
  games: Object.fromEntries(GAMES.map((game) => [game.key, emptyGameSnapshot(game)])),
};

let lastHistoryAtByGame = new Map();
let lastHistoryQuoteByKey = new Map();
let lastHistoryPruneAtByGame = new Map();
let refreshInFlight = false;
const chartCache = new Map();
// All heavy marketplace orderbook grouping is performed here, not on Cloudflare.
const publicRateCache = new Map();

function sendCompiledRate(res, url, payload) {
  if (url.pathname === "/rates/public") {
    // The table only needs quotes and server metadata. Individual listings
    // stay in the Agent and are transferred when a visitor actually opens Rate.
    const rows = payload.rows.map(({ rateDepth, ...summary }) => summary);
    sendJson(res, 200, { ...payload, rows });
    return;
  }
  const code = String(url.searchParams.get("serverCode") || "");
  const tier = String(url.searchParams.get("tier") || "");
  if (!/^[a-zA-Z0-9_-]{1,24}$/.test(code) || (tier !== "small" && tier !== "large")) {
    sendJson(res, 400, { ok: false, error: "invalid_server_or_tier" });
    return;
  }
  const row = payload.rows.find((candidate) => String(candidate.serverCode) === code);
  if (!row?.rateDepth?.[tier]) {
    sendJson(res, 404, { ok: false, error: "rate_not_found" });
    return;
  }
  sendJson(res, 200, row.rateDepth[tier]);
}
let marketStatusCache = { byOpt1: {}, byServerName: {}, fetchedAt: 0 };
let serverRegistry = { version: 1, updatedAt: null, games: {} };
let lastServerDiscoveryAt = 0;
let marketState = { updatedAt: null, games: {} };
let marketRefreshInFlight = false;
let updateCheckInFlight = false;
let updateLastCheckAt = 0;

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(LOG_DIR, { recursive: true });
serverRegistry = await loadServerRegistry();
applyServerRegistryToGames();
state = await readJson("current.json", state);
marketState = await readJson("market-current.json", marketState);
setImmediate(() => refreshAll("boot"));
setInterval(() => refreshAll("interval"), POLL_INTERVAL_MS);
setTimeout(() => refreshMarketAll("boot").catch((error) => log("market-refresh-error", { error: String(error) })), MARKET_BOOT_DELAY_MS);
setInterval(() => refreshMarketAll("interval").catch((error) => log("market-refresh-error", { error: String(error) })), MARKET_POLL_INTERVAL_MS);
if (UPDATE_ENABLED) {
  setTimeout(() => startSignedUpdateCheck("startup"), 30_000);
  setInterval(() => startSignedUpdateCheck("periodic"), UPDATE_POLL_INTERVAL_MS);
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    await log("server-error", { error: error?.stack || String(error) });
    sendJson(res, 500, { ok: false, error: "internal_error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[kira-rate-agent] listening on http://localhost:${PORT}`);
  // Confirm only after THIS process has completed a fresh successful
  // polling cycle; a persisted old snapshot is not health evidence.
  const confirmInterval = setInterval(() => {
    if (UPDATE_ENABLED && (state.status === "ok" || state.status === "partial") &&
      Date.parse(state.updatedAt) >= agentStartedAt) {
      clearInterval(confirmInterval);
      const child = spawn(process.execPath, [path.join(__dirname, "agent-updater.mjs"), "confirm"], { cwd: __dirname, windowsHide: true, stdio: "ignore" });
      child.on("error", (error) => log("update-confirm-error", { error: String(error) }));
    }
  }, 30_000);
  // A regression that never completes a fresh cycle must eventually roll
  // back, not run indefinitely in an unverified post-update state.
  setTimeout(async () => {
    try {
      const pending = await fs.access(path.join(__dirname, "updates", "verification.json")).then(() => true).catch(() => false);
      if (pending) {
        await log("update-verification-timeout", { elapsedMs: 15 * 60_000 });
        process.exit(1);
      }
    } catch { /* Never crash a healthy Agent for monitoring failure. */ }
  }, 15 * 60_000).unref();
});

function startSignedUpdateCheck(reason) {
  if (!UPDATE_ENABLED || updateCheckInFlight || Date.now() - updateLastCheckAt < 60_000) return false;
  updateCheckInFlight = true;
  updateLastCheckAt = Date.now();
  const child = spawn(process.execPath, [path.join(__dirname, "agent-updater.mjs"), "check"], {
    cwd: __dirname, windowsHide: true, stdio: "ignore",
  });
  child.on("error", async (error) => {
    updateCheckInFlight = false;
    await log("update-check-error", { reason, error: String(error) });
  });
  child.on("exit", async (code) => {
    updateCheckInFlight = false;
    if (code === 10) {
      await log("update-staged-restarting", { reason });
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 6_000).unref();
    } else if (code !== 0) {
      await log("update-check-failed", { reason, exitCode: code });
    }
  });
  return true;
}

async function route(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      version: AGENT_VERSION,
      status: state.status,
      updatedAt: state.updatedAt,
      isStale: isStateStale(),
      consecutiveFailures: state.consecutiveFailures,
    });
    return;
  }

  if (url.pathname === "/admin/update/status" && req.method === "GET") {
    if (!isUpdateAuthorized(req)) { sendJson(res, 403, { ok: false, error: "unauthorized" }); return; }
    const result = await fs.readFile(path.join(__dirname, "updates", "status.json"), "utf8")
      .then((text) => JSON.parse(text)).catch(() => ({ state: UPDATE_ENABLED ? "not-checked" : "disabled" }));
    sendJson(res, 200, { ok: true, version: AGENT_VERSION, enabled: UPDATE_ENABLED, checking: updateCheckInFlight, ...result });
    return;
  }

  if (url.pathname === "/admin/update/check" && req.method === "POST") {
    if (!isUpdateAuthorized(req)) { sendJson(res, 403, { ok: false, error: "unauthorized" }); return; }
    if (!UPDATE_ENABLED) { sendJson(res, 409, { ok: false, error: "updates_disabled" }); return; }
    if (!startSignedUpdateCheck("owner-manual")) {
      sendJson(res, 429, { ok: false, error: "update_check_busy_or_recent" });
      return;
    }
    sendJson(res, 202, { ok: true, message: "signed_update_check_started" });
    return;
  }

  if (url.pathname === "/rates/current") {
    const game = url.searchParams.get("game");
    const payload = game ? state.games[normalizeGameKey(game)] : state.games;
    sendJson(res, 200, {
      ok: true,
      version: AGENT_VERSION,
      updatedAt: state.updatedAt,
      isStale: isStateStale(),
      staleAfterMs: STALE_AFTER_MS,
      data: payload || null,
    });
    return;
  }

  if (url.pathname === "/rates/server-meta" && req.method === "GET") {
    const game = normalizeGameKey(url.searchParams.get("game") || "");
    const code = String(url.searchParams.get("serverCode") || "");
    const snapshot = state.games[game];
    const server = snapshot?.rows?.find((row) => String(row.serverCode) === code);
    sendJson(res, server ? 200 : 404, {
      ok: !!server,
      server: server ? {
        code: String(server.serverCode),
        name: String(server.serverNameKr || server.serverName || code),
        opt1: server.opt1 ? String(server.opt1) : null,
        opt3: server.opt3 ? String(server.opt3) : null,
      } : null,
    });
    return;
  }

  if ((url.pathname === "/rates/public" || url.pathname === "/rates/depth") && req.method === "GET") {
    const game = normalizeGameKey(url.searchParams.get("game") || "");
    if (!GAMES.some((item) => item.key === game)) {
      sendJson(res, 404, { ok: false, error: "unsupported_game" });
      return;
    }
    const fxRate = Number(url.searchParams.get("fxRate"));
    const deductionPercent = Number(url.searchParams.get("deduction"));
    const smallTierSpreadPercent = Number(url.searchParams.get("smallSpread"));
    const fastTierExtraSpreadPercent = Number(url.searchParams.get("fastSpread"));
    if (![fxRate, deductionPercent, smallTierSpreadPercent, fastTierExtraSpreadPercent].every(Number.isFinite) ||
      fxRate <= 0 || fxRate > 200 || deductionPercent < 0 || deductionPercent > 80 ||
      smallTierSpreadPercent < 0 || smallTierSpreadPercent > 30 || fastTierExtraSpreadPercent < 0 || fastTierExtraSpreadPercent > 30) {
      sendJson(res, 400, { ok: false, error: "invalid_rate_parameters" });
      return;
    }
    const snapshot = state.games[game];
    if (!snapshot || !Array.isArray(snapshot.rows)) {
      sendJson(res, 503, { ok: false, error: "rate_agent_unavailable" });
      return;
    }
    const key = [game, fxRate, deductionPercent, smallTierSpreadPercent, fastTierExtraSpreadPercent, snapshot.updatedAt].join(":");
    const cached = publicRateCache.get(key);
    if (cached && Date.now() - cached.at < 20000) {
      sendCompiledRate(res, url, cached.payload);
      return;
    }
    const rows = snapshot.rows.map((server) => {
      const basis = publicQuoteBasisKrw(game, server);
      const largeVnd = basis > 0 ? Math.round(basis * fxRate * (1 - deductionPercent / 100)) : null;
      const smallVnd = largeVnd != null ? Math.round(largeVnd * (1 - smallTierSpreadPercent / 100)) : null;
      const fastVnd = largeVnd != null ? Math.round(largeVnd * (1 - Math.min(30, smallTierSpreadPercent + fastTierExtraSpreadPercent) / 100)) : null;
      const common = { gameKey: game, snapshot, serverCode: server.serverCode, sourceBasisKrw: basis,
        fxRate, deductionPercent, smallTierSpreadPercent, owner: false };
      const hasData = largeVnd != null;
      return {
        serverCode: server.serverCode,
        serverNameKr: String(server.serverNameKr || server.serverName || ""),
        opt1: server.opt1 || null,
        opt3: server.opt3 || null,
        serverOrder: Number.isFinite(Number(server.serverOrder)) ? Number(server.serverOrder) : null,
        active: server.active !== false,
        quoteStatus: game === "dokkaebi" ? server.quoteStatus ?? null : null,
        sourceLastOnlineAt: game === "dokkaebi" ? server.sourceLastOnlineAt ?? null : null,
        marketChangePct: server.marketChangePct ?? null,
        smallVnd, largeVnd, fastVnd, hasData, updatedAt: server.updatedAt ?? snapshot.updatedAt ?? null,
        rateDepth: hasData ? {
          small: buildRateDepth({ ...common, tier: "small", quoteVnd: smallVnd }),
          large: buildRateDepth({ ...common, tier: "large", quoteVnd: largeVnd }),
        } : null,
      };
    });
    const payload = { ok: true, game, updatedAt: snapshot.updatedAt ?? null, stale: snapshot.isStale === true || snapshot.ok === false, rows };
    publicRateCache.set(key, { at: Date.now(), payload });
    if (publicRateCache.size > 16) publicRateCache.delete(publicRateCache.keys().next().value);
    sendCompiledRate(res, url, payload);
    return;
  }

  if (url.pathname === "/rates/history") {
    const game = normalizeGameKey(url.searchParams.get("game") || "");
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") || 500)));
    const history = await readHistory(game, limit);
    sendJson(res, 200, { ok: true, game: game || null, data: history });
    return;
  }

  if (url.pathname === "/market/heat") {
    const game = normalizeGameKey(url.searchParams.get("game") || "");
    if (!GAMES.some((item) => item.key === game)) {
      sendJson(res, 404, { ok: false, error: "unsupported_game" });
      return;
    }
    const snapshot = marketState.games[game] || null;
    sendJson(res, 200, {
      ok: true,
      game,
      available: !!snapshot,
      data: snapshot,
      updatedAt: snapshot?.updatedAt || null,
      stale: !snapshot || snapshot.complete === false || Date.now() - Date.parse(snapshot.updatedAt) > MARKET_POLL_INTERVAL_MS * 3,
    });
    return;
  }

  if (url.pathname === "/chart") {
    const game = GAMES.find((item) => item.key === normalizeGameKey(url.searchParams.get("game") || "")) || GAMES[0];
    const range = RANGE_CONFIG[url.searchParams.get("range") || "24h"] ? (url.searchParams.get("range") || "24h") : "24h";
    let opt1 = String(url.searchParams.get("opt1") || "").trim();
    let opt3 = String(url.searchParams.get("opt3") || "").trim();
    const serverCode = String(url.searchParams.get("serverCode") || "").trim();
    let serverName = String(url.searchParams.get("serverName") || "").trim();
    const series = String(url.searchParams.get("series") || "large").trim();
    const krwToVndRate = Number(url.searchParams.get("krwToVndRate") || "1");
    const krwToVndMultiplier = Number(url.searchParams.get("multiplier") || "1");
    const routeMeta = serverMetaFromSource(game, opt1, opt3) || serverMetaFromCode(game, serverCode) || serverMetaFromName(game, serverName) || serverMetaFromOpt1(game, opt1);
    opt1 = opt1 || routeMeta?.opt1 || "";
    opt3 = opt3 || routeMeta?.opt3 || "";
    serverName = serverName || routeMeta?.name || "";

    if (!opt1 && !serverName) {
      sendJson(res, 400, { ok: false, version: AGENT_VERSION, error: "missing opt1/serverName" });
      return;
    }

    const payload = await buildChartPayload(game, {
      range,
      opt1,
      opt3,
      serverCode,
      serverName,
      series,
      krwToVndRate,
      krwToVndMultiplier,
    });
    sendJson(res, 200, payload);
    return;
  }

  if (url.pathname === "/market/changes") {
    const changes = await fetchMarketChanges();
    sendJson(res, 200, {
      ok: true,
      version: AGENT_VERSION,
      updatedAt: new Date(changes.fetchedAt || Date.now()).toISOString(),
      data: changes,
    });
    return;
  }

  if (url.pathname === "/admin/status") {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      config: {
        pollIntervalMs: POLL_INTERVAL_MS,
        fetchTimeoutMs: FETCH_TIMEOUT_MS,
        serverDiscoveryIntervalMs: SERVER_DISCOVERY_INTERVAL_MS,
        games: GAMES.map(({ key, name, categoryId, unitLabel }) => ({ key, name, categoryId, unitLabel })),
      },
      serverRegistry: {
        updatedAt: serverRegistry.updatedAt || null,
        games: Object.fromEntries(GAMES.map((game) => [
          game.key,
          {
            enabled: game.autoDiscoverServers === true,
            lastDiscoveredAt: serverRegistry.games?.[game.key]?.lastDiscoveredAt || null,
            serverCount: serverRegistry.games?.[game.key]?.servers?.length || 0,
          },
        ])),
      },
      state,
    });
    return;
  }

  if (url.pathname === "/debug/barotem") {
    const game = GAMES.find((item) => item.key === normalizeGameKey(url.searchParams.get("game") || "")) || GAMES[0];
    try {
      const rawRows = await fetchBarotemRows(game.categoryId);
      const diagnostics = diagnoseRows(game, rawRows);
      sendJson(res, 200, { ok: true, version: AGENT_VERSION, game: game.key, diagnostics });
    } catch (error) {
      sendJson(res, 500, { ok: false, version: AGENT_VERSION, game: game.key, error: error?.stack || String(error) });
    }
    return;
  }

  if (url.pathname === "/admin/refresh" && req.method === "POST") {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    refreshAll("manual").catch((error) => log("manual-refresh-error", { error: error?.stack || String(error) }));
    sendJson(res, 202, { ok: true, message: "refresh_started" });
    return;
  }

  if (url.pathname === "/admin/market-refresh" && req.method === "POST") {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (marketRefreshInFlight) {
      sendJson(res, 409, { ok: false, error: "market_refresh_in_progress" });
      return;
    }
    refreshMarketAll("manual").catch((error) => log("market-refresh-error", { error: String(error) }));
    sendJson(res, 202, { ok: true, message: "market_refresh_started" });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not_found" });
}

async function refreshAll(reason) {
  if (refreshInFlight) {
    await log("refresh-skip", { reason, currentStatus: state.status });
    return;
  }
  refreshInFlight = true;
  const startedAt = Date.now();
  try {
    try {
      await discoverServersIfDue(reason === "boot");
    } catch (error) {
      await log("server-discovery-error", { reason, error: error?.message || String(error) });
    }
    const nextGames = { ...state.games };
    const errors = [];
    try {
      await fetchMarketChanges();
    } catch (error) {
      await log("gamebit-market-change-error", { reason, error: error?.message || String(error) });
    }

    for (const game of GAMES) {
      try {
        const snapshot = await fetchGame(game);
        nextGames[game.key] = snapshot;
        await maybeAppendHistory(game, snapshot);
        await sleep(650);
      } catch (error) {
        errors.push({ game: game.key, error: error?.message || String(error) });
        const previous = nextGames[game.key] || emptyGameSnapshot(game);
        nextGames[game.key] = {
          ...previous,
          ok: false,
          isStale: true,
          lastError: error?.message || String(error),
          failedAt: new Date().toISOString(),
        };
      }
    }

    state = {
      ...state,
      updatedAt: new Date().toISOString(),
      status: errors.length === GAMES.length ? "error" : errors.length ? "partial" : "ok",
      consecutiveFailures: errors.length === GAMES.length ? state.consecutiveFailures + 1 : 0,
      lastError: errors[0] || null,
      games: nextGames,
      lastDurationMs: Date.now() - startedAt,
      lastReason: reason,
    };

    await writeJson("current.json", state);
    if (errors.length) await log("refresh-errors", { reason, errors });
    console.log(`[kira-rate-agent] refresh ${state.status} in ${state.lastDurationMs}ms`);
  } finally {
    refreshInFlight = false;
  }
}

// Dedicated market inventory crawl. Never modifies the live rate source or chart.
// Market heat is a listing-activity estimate until confirmed completed trades are available.
async function refreshMarketAll(reason) {
  if (marketRefreshInFlight) return;
  marketRefreshInFlight = true;
  try {
    for (const game of GAMES) {
      try {
        const previous = await readJson(`market-listings-${game.key}.json`, null);
        const storedEvents = await readJson(`market-events-${game.key}.json`, []);
        const events = Array.isArray(storedEvents) ? storedEvents : [];
        const trustedSalesFile = VERIFIED_SALES_IMPORT_ENABLED
          ? await readJson(`completed-sales-${game.key}.json`, null)
          : null;
        const completedSales = trustedSalesFile?.approved === true &&
          trustedSalesFile?.source === "barotem_authorized_completed_history" &&
          Array.isArray(trustedSalesFile?.transactions) ? trustedSalesFile.transactions : null;
        const capture = await collectMarketListings(game);
        if (!capture.complete) {
          await log("market-incomplete", { game: game.key, reason, sourcesFailed: capture.failedSources, sourcesTruncated: capture.truncatedSources });
          // Preserve last complete snapshot. Missing pages must not count as sold.
          continue;
        }
        const snapshot = buildMarketPulse({
          game: game.key,
          serverRows: buildServerRows(game, {}),
          listings: capture.listings,
          previousListings: previous,
          recentEvents: events,
          completedSales,
        });
        const { listingIndex, listingEvent, ...publicSnapshot } = snapshot;
        publicSnapshot.coverage = { scannedSources: capture.scannedSources, listingCount: capture.listings.length, source: "barotem_sell_listings" };
        const oldestEvent = Date.now() - 30 * 86400_000;
        const recent = events.filter((event) => Date.parse(event.at) >= oldestEvent);
        if (listingEvent) recent.push(listingEvent);
        await writeJson(`market-events-${game.key}.json`, recent);
        await writeJson(`market-listings-${game.key}.json`, listingIndex);
        marketState.games[game.key] = publicSnapshot;
        marketState.updatedAt = new Date().toISOString();
        await writeJson("market-current.json", marketState);
      } catch (error) {
        await log("market-game-error", { game: game.key, reason, error: error?.message || String(error) });
      }
    }
  } finally {
    marketRefreshInFlight = false;
  }
}

async function collectMarketListings(game) {
  const sources = buildBarotemSources(game).filter((source) => source.opt1);
  const listings = new Map();
  let failedSources = 0;
  let truncatedSources = 0;
  let scannedSources = 0;
  for (const source of sources) {
    let finished = false;
    try {
      for (let page = 1; page <= MARKET_MAX_PAGES_PER_SERVER; page += 1) {
        const rows = await fetchBarotemRows(game.categoryId, source.opt1, source.opt3, game.detailOption, page);
        for (const row of rows) {
          const normalized = normalizeRow(game, {
            ...row,
            __sourceOpt1: source.opt1,
            __sourceOpt3: source.opt3,
          }, true);
          if (!normalized) continue;
          if (!normalized.serverCode) continue;
          if (!listings.has(normalized.id)) listings.set(normalized.id, normalized);
        }
        // Barotem currently returns at most 60 rows/page. A short page finishes a source.
        if (rows.length < MARKET_PAGE_SIZE) { finished = true; break; }
        if (MARKET_SOURCE_SPACING_MS > 0) await sleep(MARKET_SOURCE_SPACING_MS);
      }
      scannedSources += 1;
      if (!finished) truncatedSources += 1;
    } catch (error) {
      failedSources += 1;
      await log("market-source-error", { game: game.key, opt1: source.opt1, opt3: source.opt3, error: error?.message || String(error) });
    }
    if (MARKET_SOURCE_SPACING_MS > 0) await sleep(MARKET_SOURCE_SPACING_MS);
  }
  return {
    complete: sources.length > 0 && failedSources === 0 && truncatedSources === 0,
    listings: [...listings.values()],
    scannedSources,
    failedSources,
    truncatedSources,
  };
}

async function fetchGame(game) {
  const rows = await fetchGameRows(game);
  const normalizedRows = rows
    .map((row) => normalizeRow(game, row))
    .filter(Boolean)
    .sort((a, b) => {
      const orderDelta = serverOrderFor(game, a) - serverOrderFor(game, b);
      if (orderDelta) return orderDelta;
      const timeDelta = parseListedAtMs(b.listedAt) - parseListedAtMs(a.listedAt);
      if (timeDelta) return timeDelta;
      return a.priceKrw - b.priceKrw;
    });

  const byServer = {};
  for (const row of normalizedRows) {
    const scopedOptKey = row.opt1 && row.opt3 ? `${row.opt1}:${row.opt3}` : row.opt1;
    const keys = [row.serverCode, scopedOptKey, row.serverName]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    for (const key of keys) {
      if (!byServer[key]) byServer[key] = [];
      byServer[key].push(row);
    }
  }
  const serverRows = buildServerRows(game, byServer);

  return {
    ok: true,
    key: game.key,
    code: game.code,
    name: game.name,
    categoryId: game.categoryId,
    currencyName: game.currencyName,
    unitLabel: game.unitLabel,
    splitLabelSmall: game.splitLabelSmall,
    splitLabelLarge: game.splitLabelLarge,
    updatedAt: new Date().toISOString(),
    rawRowCount: rows.length,
    rowCount: normalizedRows.length,
    serverCount: Object.keys(byServer).length,
    configuredServerCount: serverRows.length,
    serverDiscovery: {
      enabled: game.autoDiscoverServers === true,
      registryUpdatedAt: serverRegistry.updatedAt || null,
      lastDiscoveredAt: serverRegistry.games?.[game.key]?.lastDiscoveredAt || null,
    },
    rows: serverRows,
    products: normalizedRows.slice(0, 300),
    byServer,
  };
}

function buildServerRows(game, byServer) {
  const configured = (Array.isArray(game.serverNames) ? game.serverNames : []).map((name, index) => {
    const opt1 = Array.isArray(game.serverOpt1s) ? game.serverOpt1s[index] : "";
    const opt3 = Array.isArray(game.serverOpt3s) ? game.serverOpt3s[index] : "";
    return {
      code: serverCodeAt(game, index),
      name,
      opt1,
      opt3,
      order: index + 1,
    };
  });
  const configuredKeys = new Set(
    configured.flatMap((server) => [
      server.code,
      server.opt1 && server.opt3 ? `${server.opt1}:${server.opt3}` : server.opt1,
      normalizeMarketServerName(server.name),
    ]).filter(Boolean),
  );
  const allowExtraServers = game.allowUnconfiguredServers === true;
  const extra = allowExtraServers
    ? Object.keys(byServer || {})
      .filter((name) => !configuredKeys.has(name) && !configuredKeys.has(normalizeMarketServerName(name)))
      .sort((a, b) => a.localeCompare(b, "ko"))
      .map((name, index) => ({ code: name, name, opt1: "", order: 10_000 + index }))
    : [];

  return [...configured, ...extra].map((server) => {
    const rows = rowsForServer(byServer, server);
    // Dokkaebi alone: an eligible online listing always wins over EVERY offline
    // listing, regardless of price. Offline is a labeled last-resort fallback
    // for the exact same world + shard, not a cross-server estimate.
    const onlineRows = game.key === "dokkaebi" ? rows.filter((row) => !row.isOfflineSource) : rows;
    const offlineRows = game.key === "dokkaebi" ? rows.filter((row) => row.isOfflineSource) : [];
    const liveSource = pickLatestRows(onlineRows).any;
    const offlineSource = liveSource ? null : pickLatestRows(offlineRows).any;
    const source = liveSource || offlineSource || null;
    const quoteStatus = source ? (offlineSource ? "offline" : "online") : null;
    const updatedAt = latestListedAt(rows);
    return {
      serverCode: server.code,
      serverNameKr: server.name,
      serverName: server.name,
      serverOrder: server.order,
      opt1: server.opt1 || null,
      opt3: server.opt3 || null,
      rowCount: rows.length,
      onlineRowCount: onlineRows.length,
      offlineRowCount: offlineRows.length,
      quoteStatus,
      sourceLastOnlineAt: source?.listedAt || null,
      source: source ? { priceKrw: source.priceKrw, amount: source.amount, listedAt: source.listedAt, id: source.id || null, title: source.title || null, url: source.url || null } : null,
      small: source ? { priceKrw: source.priceKrw, amount: source.amount, listedAt: source.listedAt } : null,
      large: source ? { priceKrw: source.priceKrw, amount: source.amount, listedAt: source.listedAt } : null,
      fast: source ? { priceKrw: source.priceKrw, amount: source.amount, listedAt: source.listedAt } : null,
      ratePerBasisKrwLt1m: source?.priceKrw ?? null,
      ratePerBasisKrwGt1m: source?.priceKrw ?? null,
      ratePerBasisKrwFast: source?.priceKrw ?? null,
      marketChangePct: marketChangeForServer(server),
      updatedAt,
    };
  });
}

function rowsForServer(byServer, server) {
  const serverName = typeof server === "string" ? server : server?.name;
  const candidates = typeof server === "string"
    ? [server]
    : [
        server?.code,
        server?.opt1 && server?.opt3 ? `${server.opt1}:${server.opt3}` : server?.opt1,
        server?.name,
      ].filter(Boolean);
  for (const candidate of candidates) {
    const direct = byServer?.[candidate];
    if (Array.isArray(direct)) return uniqueRows(direct);
  }
  const normalized = normalizeMarketServerName(serverName);
  const key = Object.keys(byServer || {}).find((name) => normalizeMarketServerName(name) === normalized);
  return key ? uniqueRows(byServer[key] || []) : [];
}

function uniqueRows(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows || []) {
    const id = row?.id || `${row?.serverCode || ""}:${row?.opt1 || ""}:${row?.opt3 || ""}:${row?.priceKrw || ""}:${row?.amount || ""}:${row?.title || ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(row);
  }
  return result;
}

function latestListedAt(rows) {
  const latest = (rows || [])
    .map((row) => ({ raw: row.listedAt || null, ms: parseListedAtMs(row.listedAt) }))
    .sort((a, b) => b.ms - a.ms)[0];
  return latest?.raw || null;
}

function serverPrefixForGame(game) {
  return (
    game.key === "lineageclassic" ? "S" :
    game.key === "maplestoryworld" ? "MP" :
    game.key === "sealm2" ? "SM" :
    game.key === "solenchant" ? "SE" :
    game.key === "zeus" ? "Z" :
    game.key === "eclipse" ? "E" :
    game.key === "dokkaebi" ? "DK" :
    "S"
  );
}

function serverCodeAt(game, index) {
  const registered = Array.isArray(game.serverCodes) ? String(game.serverCodes[index] || "").trim() : "";
  return registered || `${serverPrefixForGame(game)}${index + 1}`;
}

function registryServerKey(opt1, opt3 = "") {
  return `${String(opt1 || "").trim()}:${String(opt3 || "").trim()}`;
}

function seedServerEntries(game, nowIso) {
  const names = Array.isArray(game.serverNames) ? game.serverNames : [];
  const opt1s = Array.isArray(game.serverOpt1s) ? game.serverOpt1s : [];
  const opt3s = Array.isArray(game.serverOpt3s) ? game.serverOpt3s : [];
  return names.map((name, index) => ({
    code: serverCodeAt(game, index),
    name: String(name || "").trim(),
    opt1: String(opt1s[index] || "").trim(),
    opt3: String(opt3s[index] || "").trim(),
    order: index + 1,
    active: true,
    source: "seed",
    discoveredAt: nowIso,
    lastSeenAt: nowIso,
  }));
}

function numericCodeOrder(code, prefix) {
  const match = String(code || "").match(new RegExp(`^${prefix}(\\d+)$`, "i"));
  return match ? Number(match[1]) : 0;
}

function nextServerCode(game, servers) {
  const prefix = serverPrefixForGame(game);
  const max = (servers || []).reduce((value, server) => Math.max(value, numericCodeOrder(server?.code, prefix)), 0);
  return `${prefix}${max + 1}`;
}

async function loadServerRegistry() {
  const nowIso = new Date().toISOString();
  const persisted = await readJson(SERVER_REGISTRY_FILE, { version: 1, updatedAt: null, games: {} });
  const result = { version: 1, updatedAt: persisted?.updatedAt || nowIso, games: {} };

  for (const game of GAMES) {
    const savedGame = persisted?.games?.[game.key] || {};
    const savedServers = Array.isArray(savedGame.servers) ? savedGame.servers : [];
    const savedByKey = new Map(savedServers.map((server) => [registryServerKey(server?.opt1, server?.opt3), server]));
    const merged = seedServerEntries(game, nowIso).map((seed) => {
      const saved = savedByKey.get(registryServerKey(seed.opt1, seed.opt3));
      return saved
        ? {
            ...saved,
            ...seed,
            code: seed.code,
            order: seed.order,
            active: saved.active !== false,
            discoveredAt: saved.discoveredAt || seed.discoveredAt,
            lastSeenAt: saved.lastSeenAt || seed.lastSeenAt,
            source: saved.source || seed.source,
          }
        : seed;
    });
    const usedKeys = new Set(merged.map((server) => registryServerKey(server.opt1, server.opt3)));
    const usedCodes = new Set(merged.map((server) => String(server.code || "").toLowerCase()));

    for (const saved of savedServers) {
      const key = registryServerKey(saved?.opt1, saved?.opt3);
      if (!saved?.name || !saved?.opt1 || usedKeys.has(key)) continue;
      let code = String(saved.code || "").trim();
      if (!code || usedCodes.has(code.toLowerCase())) code = nextServerCode(game, merged);
      const order = Number(saved.order) || numericCodeOrder(code, serverPrefixForGame(game)) || merged.length + 1;
      merged.push({
        code,
        name: String(saved.name).trim(),
        opt1: String(saved.opt1).trim(),
        opt3: String(saved.opt3 || "").trim(),
        order,
        active: saved.active !== false,
        source: saved.source || "barotem",
        discoveredAt: saved.discoveredAt || nowIso,
        lastSeenAt: saved.lastSeenAt || null,
      });
      usedKeys.add(key);
      usedCodes.add(code.toLowerCase());
    }

    merged.sort((a, b) => Number(a.order || 99999) - Number(b.order || 99999));
    result.games[game.key] = {
      lastDiscoveredAt: savedGame.lastDiscoveredAt || null,
      servers: merged,
    };
  }
  return result;
}

function applyServerRegistryToGames() {
  for (const game of GAMES) {
    const servers = Array.isArray(serverRegistry?.games?.[game.key]?.servers)
      ? serverRegistry.games[game.key].servers
      : [];
    if (!servers.length) continue;
    const ordered = servers
      .filter((server) => isAllowedDiscoveryPair(game, server?.opt1, server?.opt3))
      .sort((a, b) => Number(a.order || 99999) - Number(b.order || 99999));
    game.serverCodes = ordered.map((server) => String(server.code || ""));
    game.serverNames = ordered.map((server) => String(server.name || ""));
    game.serverOpt1s = ordered.map((server) => String(server.opt1 || ""));
    game.serverOpt3s = ordered.some((server) => server.opt3)
      ? ordered.map((server) => String(server.opt3 || ""))
      : [];
  }
}

function isAllowedDiscoveryPair(game, opt1, opt3) {
  const rules = game?.discoveryOpt3AllowByOpt1;
  if (!rules || typeof rules !== "object") return true;
  const allowed = rules[String(opt1 || "").trim()];
  if (!Array.isArray(allowed) || !allowed.length) return true;
  return allowed.map((value) => String(value)).includes(String(opt3 || "").trim());
}

function decodeHtmlText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function parseBarotemOptions(html, optionKey) {
  const results = [];
  const seen = new Set();
  for (const match of String(html || "").matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
    const attrs = match[1] || "";
    const title = attrs.match(/data-title=["']([^"']+)["']/i)?.[1] || "";
    if (title !== optionKey) continue;
    const id = attrs.match(new RegExp(`data-${optionKey}=["']([^"']*)["']`, "i"))?.[1]?.trim() || "";
    if (!id || seen.has(id)) continue;
    const label = decodeHtmlText(match[2]);
    if (!label) continue;
    seen.add(id);
    results.push({ id, label });
  }
  return results;
}

function isDiscoverableOption(game, option, optionKey) {
  const label = String(option?.label || "").trim();
  if (!option?.id || !label || label === "전체" || label === "기타") return false;
  if (optionKey === (game.detailOption || "opt3") && Array.isArray(game.serverOpt3s) && game.serverOpt3s.length) {
    return /^\d{1,3}$/.test(label);
  }
  return true;
}

async function fetchBarotemServerOptions(game) {
  const html = await fetchText(`${BAROTEM_BASE}/product/lists/${game.categoryId}`, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    },
  });
  return {
    opt1: parseBarotemOptions(html, "opt1").filter((option) => isDiscoverableOption(game, option, "opt1")),
    opt3: parseBarotemOptions(html, "opt3").filter((option) => isDiscoverableOption(game, option, "opt3")),
    opt2: parseBarotemOptions(html, "opt2").filter((option) => isDiscoverableOption(game, option, "opt2")),
  };
}

async function discoverServersIfDue(force = false) {
  const now = Date.now();
  if (!force && lastServerDiscoveryAt && now - lastServerDiscoveryAt < SERVER_DISCOVERY_INTERVAL_MS) return;
  lastServerDiscoveryAt = now;
  const nowIso = new Date(now).toISOString();
  const discoveries = [];

  for (const game of GAMES) {
    if (game.autoDiscoverServers !== true) continue;
    const registryGame = serverRegistry.games[game.key] || { lastDiscoveredAt: null, servers: [] };
    const servers = (Array.isArray(registryGame.servers) ? registryGame.servers : [])
      .filter((server) => isAllowedDiscoveryPair(game, server?.opt1, server?.opt3));
    const byKey = new Map(servers.map((server) => [registryServerKey(server.opt1, server.opt3), server]));

    try {
      const options = await fetchBarotemServerOptions(game);
      const isComposite = servers.some((server) => server.opt3) || (Array.isArray(game.serverOpt3s) && game.serverOpt3s.length > 0);
      if (isComposite) {
        const opt3s = game.detailOption === "opt2" ? options.opt2 : options.opt3;
        for (const opt1 of options.opt1) {
          for (const opt3 of opt3s) {
            if (!isAllowedDiscoveryPair(game, opt1.id, opt3.id)) continue;
            const key = registryServerKey(opt1.id, opt3.id);
            const current = byKey.get(key);
            const name = `${opt1.label} ${opt3.label}`.trim();
            if (current) {
              current.lastSeenAt = nowIso;
              if (name && current.name !== name) current.name = name;
              continue;
            }

            let rows = [];
            try {
              rows = await fetchBarotemRows(game.categoryId, opt1.id, opt3.id, game.detailOption);
            } catch (error) {
              await log("server-discovery-probe-error", { game: game.key, opt1: opt1.id, opt3: opt3.id, error: error?.message || String(error) });
            }
            // Some Barotem option lists are global rather than world-scoped.
            // A new pair must be backed by a listing for that exact world/shard.
            if (!rows.some((row) => normalizeMarketServerName(row?.server) === normalizeMarketServerName(name))) continue;
            const code = nextServerCode(game, servers);
            const entry = {
              code,
              name,
              opt1: opt1.id,
              opt3: opt3.id,
              order: servers.length ? Math.max(...servers.map((server) => Number(server.order || 0))) + 1 : 1,
              active: true,
              source: "barotem",
              discoveredAt: nowIso,
              lastSeenAt: nowIso,
            };
            servers.push(entry);
            byKey.set(key, entry);
            discoveries.push({ game: game.key, ...entry, rowCount: rows.length });
            if (SERVER_DISCOVERY_PROBE_SPACING_MS > 0) await sleep(SERVER_DISCOVERY_PROBE_SPACING_MS);
          }
        }
      } else {
        for (const opt1 of options.opt1) {
          const key = registryServerKey(opt1.id, "");
          const current = byKey.get(key);
          if (current) {
            current.lastSeenAt = nowIso;
            if (current.name !== opt1.label) current.name = opt1.label;
            continue;
          }
          const code = nextServerCode(game, servers);
          const entry = {
            code,
            name: opt1.label,
            opt1: opt1.id,
            opt3: "",
            order: servers.length ? Math.max(...servers.map((server) => Number(server.order || 0))) + 1 : 1,
            active: true,
            source: "barotem",
            discoveredAt: nowIso,
            lastSeenAt: nowIso,
          };
          servers.push(entry);
          byKey.set(key, entry);
          discoveries.push({ game: game.key, ...entry });
        }
      }
      registryGame.lastDiscoveredAt = nowIso;
      registryGame.servers = servers;
      serverRegistry.games[game.key] = registryGame;
    } catch (error) {
      await log("server-discovery-game-error", { game: game.key, error: error?.message || String(error) });
    }
  }

  serverRegistry.updatedAt = nowIso;
  applyServerRegistryToGames();
  await writeJson(SERVER_REGISTRY_FILE, serverRegistry);
  if (discoveries.length) await log("server-discovered", { count: discoveries.length, discoveries });
}

function serverMetaFromOpt1(game, opt1) {
  if (Array.isArray(game.serverOpt3s) && game.serverOpt3s.length) return null;
  const index = (Array.isArray(game.serverOpt1s) ? game.serverOpt1s : []).findIndex((value) => String(value) === String(opt1 || ""));
  if (index < 0) return null;
  return {
    code: serverCodeAt(game, index),
    name: Array.isArray(game.serverNames) ? game.serverNames[index] : "",
    opt1: String(opt1 || ""),
    opt3: "",
    order: index + 1,
  };
}

function serverMetaFromSource(game, opt1, opt3) {
  const opt1s = Array.isArray(game.serverOpt1s) ? game.serverOpt1s : [];
  const opt3s = Array.isArray(game.serverOpt3s) ? game.serverOpt3s : [];
  const targetOpt1 = String(opt1 || "");
  const targetOpt3 = String(opt3 || "");
  const index = opt3s.length
    ? opt1s.findIndex((value, itemIndex) => String(value || "") === targetOpt1 && String(opt3s[itemIndex] || "") === targetOpt3)
    : opt1s.findIndex((value) => String(value || "") === targetOpt1);
  if (index < 0) return null;
  return {
    code: serverCodeAt(game, index),
    name: Array.isArray(game.serverNames) ? game.serverNames[index] : "",
    opt1: opt1s[index] || "",
    opt3: opt3s[index] || "",
    order: index + 1,
  };
}

function serverMetaFromName(game, name) {
  const normalized = normalizeMarketServerName(name);
  const index = (Array.isArray(game.serverNames) ? game.serverNames : []).findIndex((value) => normalizeMarketServerName(value) === normalized);
  if (index < 0) return null;
  return {
    code: serverCodeAt(game, index),
    name: game.serverNames[index],
    opt1: Array.isArray(game.serverOpt1s) ? game.serverOpt1s[index] : "",
    opt3: Array.isArray(game.serverOpt3s) ? game.serverOpt3s[index] : "",
    order: index + 1,
  };
}

function serverMetaFromCode(game, code) {
  const normalized = String(code || "").trim().toLowerCase();
  if (!normalized) return null;
  const index = (Array.isArray(game.serverNames) ? game.serverNames : []).findIndex((_, itemIndex) => serverCodeAt(game, itemIndex).toLowerCase() === normalized);
  if (index < 0) return null;
  return {
    code: serverCodeAt(game, index),
    name: game.serverNames[index],
    opt1: Array.isArray(game.serverOpt1s) ? game.serverOpt1s[index] : "",
    opt3: Array.isArray(game.serverOpt3s) ? game.serverOpt3s[index] : "",
    order: index + 1,
  };
}

function serverOrderFor(game, row) {
  return Number(row?.serverOrder) || serverMetaFromSource(game, row?.opt1, row?.opt3)?.order || serverMetaFromOpt1(game, row?.opt1)?.order || serverMetaFromName(game, row?.serverName)?.order || 99999;
}

async function fetchGameRows(game) {
  const seen = new Set();
  const merged = [];
  const sources = buildBarotemSources(game);

  for (const [sourceIndex, source] of sources.entries()) {
    try {
      const rows = await fetchBarotemRows(game.categoryId, source.opt1, source.opt3, game.detailOption);
      for (const [sourceRowIndex, row] of rows.entries()) {
        const id = String(row?.product_idx || row?.number || row?.idx || row?.id || JSON.stringify(row).slice(0, 120));
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push({
          ...row,
          __sourceOpt1: String(source.opt1 || ""),
          __sourceOpt3: String(source.opt3 || ""),
          __sourceOrder: sourceIndex,
          __sourceRowIndex: sourceRowIndex,
        });
      }
    } catch (error) {
      await log("barotem-source-error", { game: game.key, opt1: source.opt1 || null, opt3: source.opt3 || null, error: error?.message || String(error) });
    }
    if (BAROTEM_SOURCE_SPACING_MS > 0) await sleep(BAROTEM_SOURCE_SPACING_MS);
  }

  if (!merged.length) {
    throw new Error(`barotem_empty_${game.categoryId}`);
  }

  return merged;
}

function buildBarotemSources(game) {
  const opt1s = Array.isArray(game.serverOpt1s) ? game.serverOpt1s : [];
  const opt3s = Array.isArray(game.serverOpt3s) ? game.serverOpt3s : [];
  const rawSources = opt3s.length
    ? opt1s.map((opt1, index) => ({ opt1: String(opt1 || ""), opt3: String(opt3s[index] || "") }))
    : opt1s.map((opt1) => ({ opt1: String(opt1 || ""), opt3: "" }));
  rawSources.push({ opt1: "", opt3: "" });

  const seen = new Set();
  return rawSources.filter((source) => {
    const key = `${source.opt1}:${source.opt3}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function diagnoseRows(game, rows) {
  const stats = {
    rawRowCount: Array.isArray(rows) ? rows.length : 0,
    parsedRowCount: 0,
    rejectReasons: {},
    firstRaw: rows?.[0] || null,
    firstParsed: null,
  };

  for (const row of rows || []) {
    const result = normalizeRowDetailed(game, row);
    if (result.ok) {
      stats.parsedRowCount += 1;
      if (!stats.firstParsed) stats.firstParsed = result.row;
    } else {
      stats.rejectReasons[result.reason] = (stats.rejectReasons[result.reason] || 0) + 1;
    }
  }
  return stats;
}

function normalizeRowDetailed(game, row) {
  if (!row) return { ok: false, reason: "empty-row" };
  row.__game = game;
  const transactionEnd = String(row.transaction_end ?? "").trim();
  if (transactionEnd && transactionEnd !== "0") return { ok: false, reason: `transaction-end-${transactionEnd}` };
  if (isOfflineBarotemRow(row)) return { ok: false, reason: "seller-offline-by-online-date" };

  const title = String(row.product_name || row.title || row.subject || row.product_title || "");
  const sourceMeta = serverMetaFromSource(game, row.__sourceOpt1, row.__sourceOpt3) || serverMetaFromOpt1(game, row.__sourceOpt1);
  const serverName = String(sourceMeta?.name || row.server || row.opt1_name || row.server_name || "").trim();
  const priceKrw = parseKrw(row);
  const amount = parseAmount(row, title, game);
  const keywordSource = [
    title,
    row.saleUnitText,
    row.single_unit,
    row.multi_cnt,
    row.multi_minCnt,
    row.deal_quantity,
  ].filter(Boolean).join(" ");

  if (!serverName) return { ok: false, reason: "missing-server" };
  if (!priceKrw) return { ok: false, reason: "missing-price" };
  if (!isRateInRange(game, priceKrw)) return { ok: false, reason: "price-out-of-range" };
  if (game.rowKeyword && keywordSource && !keywordSource.includes(game.rowKeyword)) return { ok: false, reason: "keyword-mismatch" };
  return { ok: true, row: { serverName, amount, priceKrw, keywordSource, title, opt1: sourceMeta?.opt1 || row.__sourceOpt1 || null, opt3: sourceMeta?.opt3 || row.__sourceOpt3 || null, serverOrder: sourceMeta?.order || serverMetaFromName(game, serverName)?.order || null } };
}

async function fetchBarotemRows(categoryId, opt1 = "", opt3 = "", detailOption = "opt3", page = 1) {
  const params = new URLSearchParams({
    page: String(page),
    sell: "sell",
    category: "",
    display: "2",
    orderby: "3",
    minpay: "",
    maxpay: "",
    search_word: "",
    brand: "",
    buyloc: "",
    opt1: String(opt1 || ""),
    opt2: detailOption === "opt2" ? String(opt3 || "") : "",
    opt3: detailOption === "opt2" ? "" : String(opt3 || ""),
    opt4: "",
    opt5: "",
    opt6: "",
    opt7: "",
    opt8: "",
    opt9: "",
    opt10: "",
    total: "no",
  });
  const targetUrl = `${BAROTEM_BASE}/product/productTable/${categoryId}`;
  const referer = `${BAROTEM_BASE}/product/lists/${categoryId}`;
  const payload = await fetchJson(targetUrl, {
    method: "POST",
    body: params.toString(),
    headers: {
    Accept: "text/plain,*/*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: BAROTEM_BASE,
    Referer: referer,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!payload || payload.code !== 200 || !Array.isArray(payload.rows)) {
    throw new Error(`barotem_malformed_${categoryId}`);
  }
  return payload.rows;
}

async function fetchText(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_RETRIES) await sleep(350 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("fetch_text_failed");
}

async function fetchJson(url, options = {}) {
  const fetchOptionKeys = new Set(["method", "body", "headers", "redirect", "referrer", "referrerPolicy", "mode", "credentials", "integrity", "keepalive", "duplex"]);
  const { headers: explicitHeaders = {}, ...restOptions } = options;
  const fetchOptions = {};
  const looseHeaders = {};
  for (const [key, value] of Object.entries(restOptions || {})) {
    if (fetchOptionKeys.has(key)) {
      fetchOptions[key] = value;
    } else {
      looseHeaders[key] = value;
    }
  }
  const headers = { ...looseHeaders, ...explicitHeaders };
  let lastError;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...fetchOptions, headers, signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`http_${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_RETRIES) await sleep(800 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function normalizeRow(game, row, marketInventory = false) {
  if (!row) return null;
  row.__game = game;
  const transactionEnd = String(row.transaction_end ?? "").trim();
  if (transactionEnd && transactionEnd !== "0") return null;
  const isOfflineSource = isOfflineBarotemRow(row);
  if (isOfflineSource && game.key !== "dokkaebi" && !marketInventory) return null;

  const title = String(row.product_name || row.title || row.subject || row.product_title || "");
  const sourceMeta = serverMetaFromSource(game, row.__sourceOpt1, row.__sourceOpt3) || serverMetaFromOpt1(game, row.__sourceOpt1);
  const serverName = String(sourceMeta?.name || row.server || row.opt1_name || row.server_name || "").trim();
  const serverMeta = sourceMeta || serverMetaFromName(game, serverName);
  const rawUnitPrice = String(row.unit_price || "");
  const priceKrw = parseKrw(row);
  const amount = parseAmount(row, title, game);
  // Unit-priced listings (baro_price = price of one unit) expose their full
  // available range through Barotem's multi_minCnt/multi_cnt fields.
  // Fixed-price listings already encode total amount in baro_price and must
  // NOT use the order-increment fields as inventory totals.
  const isUnitPriceListing = game.key === "lineageclassic" &&
    Number(row.baro_price) > 0 && priceKrw > 0 &&
    Number(row.baro_price) <= priceKrw * 1.02;
  const sealM2 = game.key === "sealm2" ? sealM2ListingQuote(row) : null;
  const minAvailableAmount = sealM2 ? sealM2.minAvailableAmount :
    isUnitPriceListing ? parseKoreanQuantity(row.multi_minCnt) : null;
  const maxAvailableAmount = sealM2 ? sealM2.maxAvailableAmount :
    isUnitPriceListing ? parseKoreanQuantity(row.multi_cnt) : null;
  const keywordSource = [
    title,
    row.saleUnitText,
    row.single_unit,
    row.multi_cnt,
    row.multi_minCnt,
    row.deal_quantity,
  ].filter(Boolean).join(" ");

  if (!serverName || !priceKrw) return null;
  // The rate quote must enforce its outlier range. Market inventory instead
  // counts valid listings across the marketplace, including expensive offers.
  if (!marketInventory && !isRateInRange(game, priceKrw)) return null;
  if (game.rowKeyword && keywordSource && !keywordSource.includes(game.rowKeyword)) {
    return null;
  }

  return {
    id: String(row.product_idx || row.number || row.idx || row.id || `${serverName}-${priceKrw}-${title}`).slice(0, 96),
    gameKey: game.key,
    serverName,
    serverCode: serverMeta?.code || null,
    serverOrder: serverMeta?.order || null,
    opt1: serverMeta?.opt1 || row.__sourceOpt1 || null,
    opt3: serverMeta?.opt3 || row.__sourceOpt3 || null,
    isOfflineSource: (marketInventory || game.key === "dokkaebi") && isOfflineSource,
    title,
    amount,
    minAvailableAmount,
    maxAvailableAmount: maxAvailableAmount != null && minAvailableAmount != null &&
      maxAvailableAmount < minAvailableAmount ? null : maxAvailableAmount,
    priceKrw,
    unitPrice: rawUnitPrice,
    baroPrice: toNumber(row.baro_price),
    singleUnit: row.single_unit || null,
    saleUnitText: row.saleUnitText || null,
    listedAt: row.online_date || row.reg_date || row.zzim || null,
    url: (row.product_idx || row.number) ? `${BAROTEM_BASE}/product/view/${row.product_idx || row.number}` : null,
    sizeGroup: amount && amount >= game.splitAmount ? "large" : "small",
  };
}

function isOfflineBarotemRow(row) {
  // `onlineUse` is not enough: Barotem sets it on both online and offline
  // rows. The UI's online/offline badge tracks seller recency through
  // `online_date`, formatted in Korea time. Old active time renders offline.
  const activeAtMs = parseListedAtMs(row?.online_date);
  if (!Number.isFinite(activeAtMs) || activeAtMs <= 0) return false;
  const maxAgeMs = Number.isFinite(BAROTEM_ONLINE_MAX_AGE_MS) && BAROTEM_ONLINE_MAX_AGE_MS > 0
    ? BAROTEM_ONLINE_MAX_AGE_MS
    : 60 * 60 * 1000;
  return Date.now() - activeAtMs > maxAgeMs;
}

function parseKrw(row) {
  if (row?.__game?.key === "sealm2") return sealM2ListingQuote(row)?.priceKrw || null;
  if (row?.__game?.deriveKrwFromAmount) {
    const amount = parseAmountWithoutPrice(row, row.product_name || row.title || "");
    const baroPrice = toNumber(row.baro_price);
    const basisAmount = toNumber(row.__game.basisAmount);
    if (amount && baroPrice && basisAmount) {
      const derived = Math.round((baroPrice / amount) * basisAmount);
      if (Number.isFinite(derived) && derived > 0) return derived;
    }
  }
  const unitPrice = String(row.unit_price || "");
  const unitMatch = unitPrice.match(/([\d,]+)/);
  if (unitMatch) return Number(unitMatch[1].replace(/,/g, ""));

  const baroPrice = toNumber(row.baro_price);
  const unitEx = toNumber(row.unit_ex || row.unit);
  if (baroPrice && unitEx) return Math.round(baroPrice / unitEx);
  return null;
}

function isRateInRange(game, priceKrw) {
  const min = Number(game?.minRateKrw || 0);
  const max = Number(game?.maxRateKrw || 0);
  if (min && priceKrw < min) return false;
  if (max && priceKrw > max) return false;
  return true;
}

function parseAmount(row, title, game) {
  if (game?.key === "sealm2") return sealM2ListingQuote(row)?.amount || null;
  const baroPrice = toNumber(row.baro_price);
  const priceKrw = parseKrw(row);
  const basisAmount = toNumber(game?.basisAmount);
  if (baroPrice && priceKrw && basisAmount) {
    const derived = Math.round((baroPrice / priceKrw) * basisAmount);
    if (Number.isFinite(derived) && derived > 0) return derived;
  }

  const unitEx = toNumber(row.unit_ex || row.unit);
  if (unitEx) return unitEx;

  const source = [row.single_unit, row.multi_cnt, row.multi_minCnt, title].filter(Boolean).join(" ");
  const normalized = String(source || "").replace(/,/g, "").replace(/\s+/g, " ").toLowerCase();
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*([kKmM]?)/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = match[2];
  if (suffix === "k") return value * 1_000;
  if (suffix === "m") return value * 1_000_000;
  return value;
}

function parseAmountWithoutPrice(row, title) {
  const unitEx = toNumber(row.unit_ex || row.unit);
  if (unitEx) return unitEx;

  // Quantity fields and a title containing a Korean price must not be combined.
  for (const source of [row.single_unit, row.multi_cnt, row.multi_minCnt, title]) {
    if (!source) continue;
    const normalized = String(source).replace(/\u00a0/g, " ").replace(/,/g, "").replace(/\s+/g, " ").toLowerCase();
    const eokMatch = normalized.match(/(\d+(?:\.\d+)?)\s*억/);
    if (eokMatch) return Number(eokMatch[1]) * 100_000_000;
    const manMatch = normalized.match(/(\d+(?:\.\d+)?)\s*만/);
    if (manMatch) return Number(manMatch[1]) * 10_000;
    const match = normalized.match(/(\d+(?:\.\d+)?)\s*([km]?)/);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    return match[2] === "k" ? value * 1000 : match[2] === "m" ? value * 1000000 : value;
  }
  return null;
}

function toNumber(value) {
  const parsed = Number(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function maybeAppendHistory(game, snapshot) {
  const now = Date.now();
  const lastAt = lastHistoryAtByGame.get(game.key) || 0;
  if (now - lastAt < HISTORY_MIN_INTERVAL_MS) return;

  const lines = [];
  const serverRows = Array.isArray(snapshot.rows) && snapshot.rows.length
    ? snapshot.rows
    : buildServerRows(game, snapshot.byServer || {});

  for (const server of serverRows) {
    const serverName = String(server?.serverNameKr || server?.serverName || server?.serverCode || "").trim();
    if (!serverName) continue;
    const next = {
      small: server?.small?.priceKrw ?? server?.ratePerBasisKrwLt1m ?? null,
      large: server?.large?.priceKrw ?? server?.ratePerBasisKrwGt1m ?? null,
      fast: server?.fast?.priceKrw ?? server?.ratePerBasisKrwFast ?? null,
    };
    const key = `${game.key}:${serverName}`;
    const previous = lastHistoryQuoteByKey.get(key);
    const changed = previous
      ? ["small", "large", "fast"].filter((field) => previous[field] !== next[field])
      : ["small", "large", "fast"].filter((field) => next[field] != null);

    if (!changed.length) continue;
    lastHistoryQuoteByKey.set(key, next);
    lines.push(JSON.stringify({
      t: Math.floor(new Date(snapshot.updatedAt || Date.now()).getTime() / 1000),
      at: snapshot.updatedAt,
      game: game.key,
      categoryId: game.categoryId,
      serverCode: server?.serverCode || null,
      serverName,
      opt1: server?.opt1 || null,
      opt3: server?.opt3 || null,
      small: next.small,
      large: next.large,
      fast: next.fast,
      changed,
    }));
  }

  if (lines.length) {
    const historyFile = path.join(DATA_DIR, `history-${game.key}.ndjson`);
    await fs.appendFile(historyFile, lines.join("\n") + "\n", "utf8");
  }
  lastHistoryAtByGame.set(game.key, now);
  await maybePruneHistory(game.key, now);
}

async function maybePruneHistory(gameKey, now = Date.now()) {
  const lastPrunedAt = lastHistoryPruneAtByGame.get(gameKey) || 0;
  if (now - lastPrunedAt < HISTORY_PRUNE_INTERVAL_MS) return;
  lastHistoryPruneAtByGame.set(gameKey, now);

  const retentionMs = Math.max(1, HISTORY_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const cutoffUnix = Math.floor((now - retentionMs) / 1000);
  const file = path.join(DATA_DIR, `history-${gameKey}.ndjson`);
  let content = "";
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return;
  }

  const kept = [];
  let removed = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const time = parseTimeToUnix(row?.t ?? row?.at);
      if (!Number.isFinite(time) || time >= cutoffUnix) {
        kept.push(line);
      } else {
        removed += 1;
      }
    } catch {
      kept.push(line);
    }
  }

  if (!removed) return;
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
  await fs.rename(tmp, file);
  await log("history-pruned", { game: gameKey, removed, kept: kept.length, retentionDays: HISTORY_RETENTION_DAYS });
}

function parseListedAtMs(value) {
  if (!value || typeof value !== "string") return 0;
  const text = value.trim().replace("<br>", " ");
  const normalized = /^\d{4}-\d{2}-\d{2}/.test(text) ? `${text.replace(" ", "T")}+09:00` : text;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickLatestRows(rows) {
  const valid = (rows || []).filter((row) => row && Number.isFinite(Number(row.priceKrw)) && Number(row.priceKrw) > 0);
  const filtered = filterLowRateOutliers(valid);
  const byLowest = (items) => [...items].sort((a, b) => {
    const priceDelta = Number(a.priceKrw) - Number(b.priceKrw);
    if (priceDelta) return priceDelta;
    return parseListedAtMs(b.listedAt) - parseListedAtMs(a.listedAt);
  })[0] || null;
  return {
    any: byLowest(filtered),
    small: byLowest(filtered.filter((row) => row.sizeGroup === "small")),
    large: byLowest(filtered.filter((row) => row.sizeGroup === "large")),
  };
}

function filterLowRateOutliers(rows) {
  const valid = (rows || []).filter((row) => row && Number.isFinite(Number(row.priceKrw)) && Number(row.priceKrw) > 0);
  if (valid.length < 3) return valid;

  const gameKey = valid.find((row) => row?.gameKey)?.gameKey || "";
  const game = GAMES.find((item) => item.key === gameKey) || {};
  const sampleSize = Number(game?.lowOutlierSampleSize ?? LOW_OUTLIER_SAMPLE_SIZE);
  const keepRatio = Number(game?.lowOutlierKeepRatio ?? LOW_OUTLIER_KEEP_RATIO);
  const safeSampleSize = Number.isFinite(sampleSize) && sampleSize > 0 ? Math.min(Math.floor(sampleSize), valid.length) : Math.min(10, valid.length);
  const safeKeepRatio = Number.isFinite(keepRatio) && keepRatio > 0 && keepRatio < 1 ? keepRatio : 0.55;
  const sample = [...valid].sort((a, b) => Number(a.priceKrw) - Number(b.priceKrw)).slice(0, safeSampleSize);
  const average = sample.reduce((sum, row) => sum + Number(row.priceKrw), 0) / sample.length;
  const floor = average * safeKeepRatio;
  if (!Number.isFinite(floor) || floor <= 0) return valid;
  const filtered = valid.filter((row) => Number(row.priceKrw) >= floor);
  return filtered.length ? filtered : valid;
}

function normalizeMarketServerName(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function normalizeMarketChangeEntry(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? { changePct: value, price: null, lastUpdate: null } : null;
  }
  const changePct = Number(value?.changePct ?? value?.rate ?? value?.change ?? value?.percent);
  const price = Number(value?.price ?? value?.current ?? value?.value);
  return {
    changePct: Number.isFinite(changePct) ? changePct : null,
    price: Number.isFinite(price) ? price : null,
    lastUpdate: value?.lastUpdate || value?.last_update || null,
  };
}

function marketChangeForServer(server) {
  for (const key of marketLookupKeys(server)) {
    const byOpt1 = normalizeMarketChangeEntry(marketStatusCache.byOpt1?.[key]);
    if (byOpt1?.changePct != null) return byOpt1.changePct;
  }
  const byName = normalizeMarketChangeEntry(marketStatusCache.byServerName?.[normalizeMarketServerName(server?.name)]);
  if (byName?.changePct != null) return byName.changePct;
  return null;
}

function marketLookupKeys(server) {
  const keys = [];
  const opt1 = String(server?.opt1 || "");
  const opt3 = String(server?.opt3 || "");
  const detail = detailSuffixFromOpt3(opt3);
  if (opt1 && detail) keys.push(`${opt1}${detail}`);
  if (opt1 && opt3) keys.push(`${opt1}:${opt3}`);
  if (opt3) keys.push(opt3);
  if (opt1) keys.push(opt1);
  return keys.filter(Boolean);
}

function detailSuffixFromOpt3(opt3) {
  return {
    "26749": "01",
    "26750": "02",
    "26751": "03",
    "26752": "04",
    "26753": "05",
    "27947": "01",
    "27948": "02",
    "27949": "03",
    "28078": "01",
    "28079": "02",
    "28080": "03",
    "28081": "04",
    "28082": "05",
    "28083": "06",
  }[String(opt3 || "")] || "";
}

async function fetchMarketChanges() {
  const now = Date.now();
  const hasCache =
    Object.keys(marketStatusCache.byOpt1 || {}).length > 0 ||
    Object.keys(marketStatusCache.byServerName || {}).length > 0;
  if (hasCache && now - marketStatusCache.fetchedAt < MARKET_CACHE_TTL_MS) {
    return marketStatusCache;
  }

  const byOpt1 = {};
  const byServerName = {};
  let lastError = null;

  for (const statusUrl of GAMEBIT_TOTAL_STATUS_URLS) {
    try {
      const payload = await fetchJson(statusUrl, {
        Accept: "application/json,text/plain,*/*",
        Referer: "https://gamebit.co.kr/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) KiraRateAgent/1.0",
      });
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("gamebit total malformed");
      for (const [opt1, item] of Object.entries(payload)) {
        const changePct = Number(item?.rate ?? item?.changePct ?? item?.change);
        const price = Number(item?.price);
        if (!Number.isFinite(changePct)) continue;
        byOpt1[String(opt1)] = {
          changePct,
          price: Number.isFinite(price) ? price : null,
          lastUpdate: item?.last_update || item?.lastUpdate || null,
        };
      }
      break;
    } catch (error) {
      lastError = error;
    }
  }

  for (const statusUrl of GAMEBIT_EXTRA_STATUS_URLS) {
    try {
      const payload = await fetchJson(statusUrl, {
        Accept: "application/json,text/plain,*/*",
        Referer: "https://gamebit.co.kr/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) KiraRateAgent/1.0",
      });
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("gamebit extra malformed");
      for (const [id, item] of Object.entries(payload)) {
        const changePct = Number(item?.rate ?? item?.changePct ?? item?.change);
        const price = Number(item?.price);
        if (!Number.isFinite(changePct)) continue;
        const entry = {
          changePct,
          price: Number.isFinite(price) ? price : null,
          lastUpdate: item?.last_update || item?.lastUpdate || null,
        };
        byOpt1[String(id)] = entry;
        const serverName = normalizeMarketServerName(item?.server_name || item?.name || "");
        if (serverName) byServerName[serverName] = entry;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (normalizeMarketChangeEntry(byOpt1["26208"])?.changePct != null) {
    byServerName[normalizeMarketServerName("일반")] = byOpt1["26208"];
  }

  const hasAny =
    Object.keys(byOpt1).length > 0 ||
    Object.keys(byServerName).length > 0;
  if (!hasAny && lastError) throw lastError;

  marketStatusCache = { byOpt1, byServerName, fetchedAt: now };
  return marketStatusCache;
}

function getGamebitChartGame(gameKey) {
  if (gameKey === "lineageclassic") return "aden";
  if (gameKey === "maplestoryworld" || gameKey === "mapleland") return "mapleworld";
  if (gameKey === "solenchant") return "solenchant";
  if (gameKey === "zeus") return "zeus";
  // Gamebit currently marks Eclipse as 준비 중 (disabled), so keep its
  // chart source Barotem-only until a real Gamebit endpoint is verified.
  if (gameKey === "eclipse") return null;
  return null;
}

function parseTimeToUnix(value) {
  if (Number.isFinite(value)) return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function filterByWindow(points, windowMs) {
  if (!Array.isArray(points) || !points.length) return [];
  const maxTime = points.reduce((acc, item) => Math.max(acc, Number(item?.time) || 0), 0);
  const minTime = maxTime - Math.floor(windowMs / 1000);
  return points
    .filter((item) => Number(item?.time) >= minTime)
    .sort((a, b) => Number(a.time) - Number(b.time));
}

function smoothLine(points, maxJumpRatio = 0.15) {
  if (!Array.isArray(points) || points.length < 3) return Array.isArray(points) ? points : [];
  const result = [points[0]];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = Number(result[result.length - 1]?.value ?? result[result.length - 1]?.close);
    const current = Number(points[index]?.value ?? points[index]?.close);
    const next = Number(points[index + 1]?.value ?? points[index + 1]?.close);
    if (previous > 0 && current > 0 && next > 0) {
      const jumpFromPrevious = Math.abs(current - previous) / previous;
      const jumpToNext = Math.abs(current - next) / current;
      const nextCloseToPrevious = Math.abs(next - previous) / previous;
      if (jumpFromPrevious > maxJumpRatio && jumpToNext > maxJumpRatio && nextCloseToPrevious < maxJumpRatio) {
        continue;
      }
    }
    result.push(points[index]);
  }
  result.push(points[points.length - 1]);
  return result;
}

function downsamplePoints(points, maxPoints) {
  if (!Array.isArray(points) || points.length <= maxPoints) return Array.isArray(points) ? points : [];
  const step = Math.ceil(points.length / maxPoints);
  const sampled = [];
  for (let index = 0; index < points.length; index += step) sampled.push(points[index]);
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

function compactChartSeries(points, range, smooth = false) {
  const fallbackMax = range === "24h" ? 520 : range === "7d" ? 900 : 900;
  const configuredMax = Number(CHART_MAX_POINTS[range] || fallbackMax);
  const maxPoints = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : fallbackMax;
  const normalized = smooth ? smoothLine(points) : (Array.isArray(points) ? points : []);
  return downsamplePoints(normalized, maxPoints);
}

function toVndPrice(valueKrw, krwToVndRate, krwToVndMultiplier) {
  const value = Number(valueKrw);
  const fx = Number(krwToVndRate);
  const multiplier = Number(krwToVndMultiplier);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(fx) || fx <= 0 || !Number.isFinite(multiplier) || multiplier <= 0) {
    return null;
  }
  return Math.round(value * fx * multiplier);
}

function getLatestUnix(points) {
  if (!Array.isArray(points) || !points.length) return null;
  const latest = points.reduce((acc, point) => Math.max(acc, Number(point?.time) || 0), 0);
  return Number.isFinite(latest) && latest > 0 ? latest : null;
}

function computeFreshness(lines, candles, nowMs) {
  const candidates = [
    getLatestUnix(lines?.market || []),
    getLatestUnix(lines?.barotem || []),
    getLatestUnix(candles?.volatility || []),
  ].filter((value) => Number.isFinite(value) && value > 0);

  if (!candidates.length) return null;
  const latestUnix = Math.max(...candidates);
  const lagMinutes = Math.max(0, Math.floor((nowMs - latestUnix * 1000) / 60000));
  return {
    latestPricePointAt: new Date(latestUnix * 1000).toISOString(),
    lagMinutes,
    isDelayed: lagMinutes >= 15,
    thresholdMinutes: 15,
  };
}

function pickHistoryRateKrw(serverData, series = "large") {
  if (!serverData) return null;
  if ("serverName" in serverData) {
    const preferred = Number(serverData?.[series]);
    if (Number.isFinite(preferred) && preferred > 0) return preferred;
    for (const key of ["large", "small", "fast"]) {
      const value = Number(serverData?.[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  }
  for (const key of [`latest${series.charAt(0).toUpperCase()}${series.slice(1)}`, "latestLarge", "latestSmall", "latest", "min", "max"]) {
    const value = Number(serverData?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

async function buildAgentBarotemLine(gameKey, serverName, range, series = "large") {
  const cfg = RANGE_CONFIG[range] || RANGE_CONFIG["24h"];
  const historyLimit = range === "30d"
    ? Number(env.CHART_HISTORY_LIMIT_30D || 100000)
    : range === "7d"
      ? Number(env.CHART_HISTORY_LIMIT_7D || 50000)
      : Number(env.CHART_HISTORY_LIMIT_24H || 15000);
  const history = await readHistory(gameKey, historyLimit);
  const points = [];

  for (const item of history) {
    const time = parseTimeToUnix(item?.t ?? item?.at);
    const isEvent = item?.serverName === serverName;
    const serverData = isEvent ? item : item?.servers?.[serverName];
    const rateKrw = serverData ? pickHistoryRateKrw(serverData, series) : null;
    if (Number.isFinite(time) && Number.isFinite(rateKrw) && rateKrw > 0) {
      points.push({ time, valueKrw: rateKrw });
    }
  }

  const filtered = filterByWindow(points, cfg.windowMs);
  if (filtered.length) {
    const nowUnix = Math.floor(Date.now() / 1000);
    const startUnix = nowUnix - Math.floor(cfg.windowMs / 1000);
    const result = [...filtered].sort((a, b) => a.time - b.time);
    if (result[0].time > startUnix) {
      result.unshift({ time: startUnix, valueKrw: result[0].valueKrw, synthetic: true });
    }
    if (result[result.length - 1].time < nowUnix) {
      result.push({ time: nowUnix, valueKrw: result[result.length - 1].valueKrw, synthetic: true });
    }
    return result;
  }

  const rows = Array.isArray(state.games?.[gameKey]?.byServer?.[serverName])
    ? state.games[gameKey].byServer[serverName]
    : [];
  const latest = pickLatestRows(rows || []);
  // Small/Large/Fast intentionally share one filtered Barotem source.
  // Public tier differences are applied later by the website spread logic.
  const currentKrw = latest.any?.priceKrw;
  if (!currentKrw) return [];
  const nowUnix = Math.floor(Date.now() / 1000);
  return [
    { time: nowUnix - Math.min(Math.floor(cfg.windowMs / 1000), 3600), valueKrw: currentKrw, synthetic: true },
    { time: nowUnix, valueKrw: currentKrw, synthetic: true },
  ];
}

async function fetchGamebitChart(game, opt1, range, krwToVndRate, krwToVndMultiplier) {
  const gamebitGame = getGamebitChartGame(game.key);
  if (!gamebitGame || !opt1) return { market: [], candles: [], volume: [] };

  const cfg = RANGE_CONFIG[range] || RANGE_CONFIG["24h"];
  const priceDivisor = Number(game.gamebitPriceDivisor || 1);
  const targetUrl = `${GAMEBIT_CHART_URL}?game=${encodeURIComponent(gamebitGame)}&sid=${encodeURIComponent(opt1)}&type=${cfg.gamebitType}`;
  const payload = await fetchJson(targetUrl, {
    Accept: "application/json,text/plain,*/*",
    Referer: "https://gamebit.co.kr/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) KiraRateAgent/1.0",
  });
  if (!Array.isArray(payload)) return { market: [], candles: [], volume: [] };

  const candles = [];
  const volume = [];
  for (const item of payload) {
    const time = parseTimeToUnix(item?.time);
    if (!Number.isFinite(time)) continue;
    const open = toVndPrice(Number(item?.open) / priceDivisor, krwToVndRate, krwToVndMultiplier);
    const high = toVndPrice(Number(item?.high) / priceDivisor, krwToVndRate, krwToVndMultiplier);
    const low = toVndPrice(Number(item?.low) / priceDivisor, krwToVndRate, krwToVndMultiplier);
    const close = toVndPrice(Number(item?.close) / priceDivisor, krwToVndRate, krwToVndMultiplier);
    if ([open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) {
      candles.push({ time, open, high, low, close });
      const volValue = Number(item?.volume);
      if (Number.isFinite(volValue) && volValue >= 0) {
        volume.push({ time, value: volValue, isUp: close >= open });
      }
    }
  }

  const filteredCandles = compactChartSeries(filterByWindow(candles, cfg.windowMs), range, false);
  return {
    market: filteredCandles.map((point) => ({ time: point.time, value: point.close })),
    candles: filteredCandles,
    volume: compactChartSeries(filterByWindow(volume, cfg.windowMs), range, false),
  };
}

async function buildChartPayload(game, options) {
  const range = RANGE_CONFIG[options.range] ? options.range : "24h";
  const series = ["small", "large"].includes(options.series) ? options.series : "large";
  const cacheKey = `${game.key}:${options.opt1 || options.serverName}:${options.opt3 || ""}:${range}:${series}`;
  const now = Date.now();
  const cached = chartCache.get(cacheKey);
  if (cached && now - cached.cachedAt < CHART_CACHE_TTL_MS) {
    return { ...cached.payload, cached: true };
  }

  const gamebitSid = gamebitSidForSource(game, options.opt1, options.opt3);
  const gamebitResult = await Promise.resolve(fetchGamebitChart(game, gamebitSid, range, 1, 1)).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", reason: error }),
  );
  const barotemResult = await Promise.resolve(buildAgentBarotemLine(game.key, options.serverName, range, series)).then(
    (points) => ({ status: "fulfilled", value: points }),
    (error) => ({ status: "rejected", reason: error }),
  );
  const gamebit = gamebitResult.status === "fulfilled" ? gamebitResult.value : { market: [], candles: [], volume: [] };
  const barotem = barotemResult.status === "fulfilled" ? barotemResult.value : [];
  const points = Array.isArray(gamebit.market) && gamebit.market.length ? gamebit.market : barotem;

  const payload = {
    ok: true,
    version: AGENT_VERSION,
    server: { serverCode: options.serverCode || null, serverNameKr: options.serverName || null, opt1: options.opt1 || null, opt3: options.opt3 || null },
    game: { key: game.key, name: game.name, assetName: game.currencyName },
    range,
    series,
    currency: "KRW",
    updatedAt: new Date(now).toISOString(),
    source: Array.isArray(gamebit.market) && gamebit.market.length ? "gamebit" : "barotem-history",
    isStale: gamebitResult.status !== "fulfilled" && barotemResult.status !== "fulfilled",
    lines: {
      market: gamebit.market || [],
      barotem,
    },
    candles: {
      market: gamebit.candles || [],
      volume: gamebit.volume || [],
    },
    freshness: computeFreshness({ market: gamebit.market || [], barotem }, { volatility: gamebit.candles || [] }, now),
    points,
    current: points.length ? (points[points.length - 1].valueKrw ?? points[points.length - 1].value ?? points[points.length - 1].close ?? null) : null,
  };
  chartCache.set(cacheKey, { payload, cachedAt: now });
  return payload;
}

function gamebitSidForSource(game, opt1, opt3) {
  const detail = detailSuffixFromOpt3(opt3);
  if ((game.key === "solenchant" || game.key === "zeus" || game.key === "eclipse") && opt1 && detail) return `${opt1}${detail}`;
  return opt1 || "";
}

async function readHistory(game, limit) {
  const files = game
    ? [path.join(DATA_DIR, `history-${game}.ndjson`)]
    : GAMES.map((item) => path.join(DATA_DIR, `history-${item.key}.ndjson`));

  const rows = [];
  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf8");
      for (const line of content.trim().split(/\r?\n/)) {
        if (!line) continue;
        rows.push(JSON.parse(line));
      }
    } catch {
      // Missing history file is normal on first run.
    }
  }

  return rows.slice(-limit);
}

function emptyGameSnapshot(game) {
  return {
    ok: false,
    key: game.key,
    code: game.code,
    name: game.name,
    categoryId: game.categoryId,
    currencyName: game.currencyName,
    unitLabel: game.unitLabel,
    updatedAt: null,
    rowCount: 0,
    serverCount: 0,
    rows: [],
    byServer: {},
  };
}

function normalizeGameKey(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "");
  const game = GAMES.find((item) => {
    return (
      item.key.toLowerCase() === normalized ||
      item.code.toLowerCase().replace(/_/g, "") === normalized ||
      item.categoryId.toLowerCase() === normalized
    );
  });
  return game?.key || normalized;
}

function isStateStale() {
  if (!state.updatedAt) return true;
  return Date.now() - new Date(state.updatedAt).getTime() > STALE_AFTER_MS;
}

function isAuthorized(req) {
  if (!SECRET) return true;
  return req.headers["x-kira-rate-secret"] === SECRET || req.headers.authorization === `Bearer ${SECRET}`;
}

function isUpdateAuthorized(req) {
  return !!UPDATE_CONTROL_SECRET && req.headers["x-kira-update-secret"] === UPDATE_CONTROL_SECRET;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Kira-Rate-Secret");
  res.setHeader("Cache-Control", "no-store");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(fileName, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, fileName), "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(fileName, data) {
  const tmp = path.join(DATA_DIR, `${fileName}.tmp`);
  const finalPath = path.join(DATA_DIR, fileName);
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, finalPath);
}

async function log(event, data) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }) + "\n";
  await fs.appendFile(path.join(LOG_DIR, "agent.ndjson"), line, "utf8");
}

async function loadEnv(file) {
  const result = {};
  try {
    const content = await fs.readFile(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
    }
  } catch {
    // No env file yet.
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
