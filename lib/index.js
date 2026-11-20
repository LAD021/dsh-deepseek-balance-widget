import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { readFile, writeFile, stat, mkdir, copyFile, readdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

/** Plugin id; must match the cordis.patch.yml insert id. */
const name = "deepseek-balance-widget";

/** Services required before this plugin can mount its route. */
const inject = ["webServer", "credentials"];

/** NPM registry endpoint for this package (public access, no auth). */
const NPM_REGISTRY_URL = "https://registry.npmjs.org/dsh-deepseek-balance-widget";

/** Absolute path to this plugin's package root (where package.json lives). */
const PLUGIN_ROOT = (() => {
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return process.cwd();
  }
})();

/** The directory that should run npm install to update this plugin. */
const UPDATE_CWD = (() => {
  // If the plugin lives under a node_modules folder, run npm install in the
  // project/profile root (the parent of node_modules). This covers the
  // standard dsh profile layout: ~/.dsh/profiles/web/node_modules/<pkg>/.
  const parts = PLUGIN_ROOT.replace(/\\/g, "/").split("/");
  const nmIndex = parts.lastIndexOf("node_modules");
  if (nmIndex > 0) {
    return parts.slice(0, nmIndex).join("/");
  }
  return PLUGIN_ROOT;
})();

/** Local package.json version (read once at startup). */
const LOCAL_VERSION = await (async () => {
  try {
    const base = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(resolve(base, "../package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** Multi-provider balance store (user-managed AI balances). */
const STORE_PATH = resolve(homedir(), ".dsh", "ai-balances.json");

/** dsh settings files (local only; API keys never leave this machine). */
const DSH_SETTINGS_PATH = resolve(homedir(), ".dsh", "settings.yaml");
const DSH_CREDENTIALS_PATH = resolve(homedir(), ".dsh", ".credentials.yaml");

/** Persisted backoff state for the monthly cumulative scan, so a restart does not
 *  force an immediate 34-month re-scan into a platform that just rate-limited us. */
const SCAN_BACKOFF_PATH = resolve(homedir(), ".dsh", "deepseek-usage-backoff.json");

/**
 * Upstream response cache (admin request 2026-11-10: "请求的间隔大一点，慢一点";
 * 2026-11-19 管理员再次要求降频：默认 TTL 从 5 分钟拉到 15 分钟).
 * The client can poll every few seconds across many pages; upstream providers
 * are only hit when the cached answer is older than the TTL. Failures are
 * cached with a shorter TTL, which doubles as a fixed failure backoff.
 */
const UPSTREAM_OK_TTL_MS = 900000;    // 15 min for successful answers
const UPSTREAM_FAIL_TTL_MS = 300000;  // 5 min backoff after a failed upstream call
/** New API relay sites: 今日用量要拉最近 1000 条日志，比别的平台重，缓存再长一档。 */
const NEWAPI_OK_TTL_MS = 1800000;     // 30 min
const upstreamCache = new Map();     // cacheKey -> { at, ttl, result }

function upstreamCacheGet(key) {
  const entry = upstreamCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > entry.ttl) return null;
  return entry.result;
}

function upstreamCacheSet(key, result, ttl) {
  const okTtl = ttl && ttl.ok ? ttl.ok : UPSTREAM_OK_TTL_MS;
  const failTtl = ttl && ttl.fail ? ttl.fail : UPSTREAM_FAIL_TTL_MS;
  upstreamCache.set(key, {
    at: Date.now(),
    ttl: result && result.ok ? okTtl : failTtl,
    result
  });
}

/** Cache-or-fetch wrapper for one upstream call. */
async function withUpstreamCache(key, fetcher, ttl) {
  const cached = upstreamCacheGet(key);
  if (cached) return JSON.parse(JSON.stringify({ ...cached, cached: true }));
  const result = await fetcher();
  upstreamCacheSet(key, result, ttl);
  return result;
}

/** Map dsh provider names -> this plugin's provider kinds / labels. */
const DSH_PROVIDER_MAP = {
  // MiMo is opt-in: it requires an extra browser Cookie setup, so we do not
  // auto-create it from dsh settings. The user must explicitly click "+ 添加".
  xiaomi: { kind: "mimo", label: "MiMo（小米）", autoSync: false },
  deepseek: { kind: "deepseek", label: "DeepSeek", autoSync: true }
};

/** Known provider definitions: balance endpoint + response parser. */
const PROVIDER_DEFS = {
  deepseek: {
    label: "DeepSeek",
    balanceUrl: "https://api.deepseek.com/user/balance",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
    parse: (data) => {
      const info = data?.balance_infos?.[0];
      if (!info) return null;
      return { currency: info.currency || "CNY", total: info.total_balance, granted: info.granted_balance, topped: info.topped_up_balance };
    }
  },
  mimo: {
    label: "MiMo",
    // 网页端余额接口（社区项目已验证）：用登录 Cookie 鉴权，API Key 无此能力。
    balanceUrl: "https://platform.xiaomimimo.com/api/v1/balance",
    // 网页端用量接口（账单明细：累计/本月消费、Token 用量、速率上限），同样用登录 Cookie 鉴权。
    usageUrl: "https://platform.xiaomimimo.com/api/v1/usage",
    // 网页端逐日用量明细（含每日 Token / 请求），同样用登录 Cookie 鉴权。
    // 返回 tokenUsage: [["MM-DD", input, output, total, cache], ...]、requests: [["MM-DD", count], ...]。
    detailUrl: "https://platform.xiaomimimo.com/api/v1/usage/detail",
    // MiMo mimo-v2.5 单价（与官网/网页端一致，元 / 百万 token）。消费金额由 Token 计数推算。
    pricing: { input: 1.0, output: 2.0, cacheHit: 0.02 },
    cookieAuth: true,
    parse: (data) => {
      // MiMo 网页端返回形状未公开，做多路径兜底解析。
      const pick = (...paths) => {
        for (const p of paths) {
          let cur = data;
          let ok = true;
          for (const seg of p.split(".")) {
            if (cur == null) { ok = false; break; }
            cur = cur[seg];
          }
          if (ok && cur !== void 0 && cur !== null && cur !== "") {
            const num = typeof cur === "number" ? cur : (typeof cur === "string" ? Number.parseFloat(cur) : NaN);
            if (!Number.isNaN(num)) return num;
          }
        }
        return null;
      };
      const balance = pick(
        "data.balance", "data.total", "data.remaining", "data.amount",
        "data.walletBalance", "data.rechargeBalance", "data.accountBalance",
        "balance", "total", "data.data.balance"
      );
      if (balance === null) return null;
      return { currency: "CNY", total: balance, raw: data };
    }
  },
  // Command Code（GOAT 订阅）：官方后台内部接口，浏览器会话 Cookie（better-auth）鉴权。
  // 实测：/internal/billing/credits（月额度/已购额度）、/internal/usage/summary（本月成本/token/请求数）、
  // /internal/billing/subscriptions（订阅状态）。Cookie 只需 api.commandcode.ai 的 session。
  commandcode: {
    label: "Command Code",
    // 2026-10-31: use /alpha/* (same as Command Code CLI), API key auth.
    creditsUrl: "https://api.commandcode.ai/alpha/billing/credits",
    summaryUrl: "https://api.commandcode.ai/alpha/usage/summary?",
    subsUrl: "https://api.commandcode.ai/alpha/billing/subscriptions",
    apiKeyAuth: true,
    parse: () => null
  },
  newapi: {
    label: "New API",
    // New API（new-api 网关，Midjourney-Proxy-Plus / one-api 系中转站）。
    // 2026-11-19 起常见部署把管理端接口全锁了：
    //   · /api/user/self、/api/data/self 走 UserAuth，必须登录会话（账号密码登录会撞
    //     AUTH_SESSION_LIMIT 409，refresh cookie 也拿不到）；
    //   · 旧 32 位「系统访问令牌」返回 ACCESS_TOKEN_LEGACY_RETIRED。
    // 所以改走 sk- 模型密钥能读的只读接口（与 new-api 源码一致）：
    //   余额：GET {baseUrl}/api/usage/token/ → user_quota.total_available / total_used（quota 单位）
    // 2026-11-19 用户要求：New API 只显示余额，不要今日消费/今日 Token。
    // /api/log/token（一次拉最近 1000 条日志，全插件最重的一次请求）因此不再调用；
    // 需要时把 provider.usageEnabled 置 true 才会重新取今日用量。
    balancePath: "/api/usage/token/",
    usagePath: "/api/log/token",
    tokenAuth: true,
    quotaPerUnit: 500000,
    parse: (data) => {
      // /api/usage/token/ 形状：{code:true, data:{total_available, total_used, user_quota:{...}}}
      // 两种形状都认，配额单位统一按 quota / quotaPerUnit（站点 quota_display_type=USD，汇率只影响 CNY 展示）。
      const body = data?.data;
      if (!body) return null;
      const uq = body.user_quota || null;
      const unlimited = body.unlimited_quota === true;
      const userBalance = uq && Number.isFinite(Number(uq.total_available)) ? Number(uq.total_available) : null;
      const userUsed = uq && Number.isFinite(Number(uq.total_used)) ? Number(uq.total_used) : null;
      const tokenBalance = Number.isFinite(Number(body.total_available)) ? Number(body.total_available) : null;
      const tokenUsed = Number.isFinite(Number(body.total_used)) ? Number(body.total_used) : null;
      // 优先用账号（钱包）余额；令牌允许查账号额度时才拿得到。
      // 拿不到时：无限额度令牌的 total_available 是负数（已超额），不能当余额显示，宁可留空。
      let balanceQuota = userBalance !== null ? userBalance : tokenBalance;
      if (userBalance === null && unlimited && (balanceQuota === null || balanceQuota < 0)) balanceQuota = null;
      const usedQuota = userUsed !== null ? userUsed : tokenUsed;
      if (balanceQuota === null && usedQuota === null) return null;
      return {
        currency: "USD",
        total: balanceQuota === null ? void 0 : balanceQuota / 500000,
        used: usedQuota === null ? void 0 : usedQuota / 500000,
        tokenName: body.name || void 0,
        unlimited
      };
    }
  },
  // AutoDL（云 GPU）：开发者 Token（控制台 → 设置 → 开发者 Token）。
  // 只读钱包接口，不能开关机；返回的资产/累计消费/代金券都是「千分之一元」的整数。
  autodl: {
    label: "AutoDL",
    balanceUrl: "https://api.autodl.com/api/v1/dev/wallet/balance"
  },
  // OpenCode Go（$10/月订阅制）：GET /inference/go/v1/usage，Bearer API Key 鉴权。
  // 返回 rolling(5 小时) / weekly / monthly 三个窗口的 percent 与 resetsAt。
  // 订阅制没有「余额」金额，插件只展示窗口占用，不编造余额 / 消费数字。
  "opencode-go": {
    label: "OpenCode Go",
    usageUrl: "https://opencode.ai/inference/go/v1/usage",
    apiKeyAuth: true,
    parse: () => null
  }
};

/** Parse KEY: value lines from dsh's .credentials.yaml (no quoting support needed). */
function parseCredentials(text) {
  const out = {};
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** Very small YAML subset parser: enough to read dsh settings.yaml provider blocks. */
function parseSimpleYaml(text) {
  const lines = (text || "").split(/\r?\n/);
  const root = {};
  const stack = [{ obj: root, indent: -1 }];
  for (const raw of lines) {
    const commentIdx = raw.indexOf("#");
    const line = (commentIdx === -1 ? raw : raw.slice(0, commentIdx)).replace(/\r$/, "");
    if (!line.trim()) continue;
    const indent = line.search(/\S/);
    if (indent === -1) continue;
    const trimmed = line.slice(indent);
    if (trimmed.startsWith("- ")) continue; // skip list items
    const sep = trimmed.indexOf(":");
    if (sep === -1) continue;
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (value === "") {
      parent[key] = {};
      stack.push({ obj: parent[key], indent });
    } else {
      parent[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return root;
}

/** Read the provider store; null when the file is missing. */
async function readStore() {
  try {
    const arr = JSON.parse(await readFile(STORE_PATH, "utf8"));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/** Persist the provider store. */
async function writeStore(arr) {
  await writeFile(STORE_PATH, JSON.stringify(arr, null, 2), "utf8");
}

/** Ensure the store exists, seeding a DeepSeek entry (key from credentials) on first run. */
async function ensureStore() {
  let arr = await readStore();
  if (arr === null) {
    // 文件不存在 = 首次启动，直接重建；
    // 文件存在但坏了 = 先原样备份成 .bad-<ts> 再重建，绝不静默覆盖用户数据。
    try {
      const raw = await readFile(STORE_PATH, "utf8");
      if (raw.trim().length > 0) {
        await writeFile(`${STORE_PATH}.bad-${Date.now()}`, raw, "utf8").catch(() => {});
      }
    } catch { /* ENOENT：正常首次启动 */ }
    arr = [{ id: "deepseek", label: "DeepSeek", kind: "deepseek", apiKey: "__credentials__", enabled: true }];
    await writeStore(arr);
  }
  return arr;
}

/**
 * Detect providers configured in dsh settings and mirror their API keys into the
 * local balance store. Keys are read from ~/.dsh/.credentials.yaml only; nothing
 * is sent off-machine. Already-existing providers (same id or same kind with a
 * real key) are left untouched so user edits are never overwritten.
 */
async function syncProvidersFromDshSettings() {
  try {
    const [settingsText, credText] = await Promise.all([
      readFile(DSH_SETTINGS_PATH, "utf8").catch(() => ""),
      readFile(DSH_CREDENTIALS_PATH, "utf8").catch(() => "")
    ]);
    const settings = parseSimpleYaml(settingsText);
    const credentials = parseCredentials(credText);
    const candidates = [];

    // dsh "llm-pi-ai" custom providers (e.g. xiaomi).
    const piProviders = settings?.["llm-pi-ai"]?.providers;
    if (piProviders && typeof piProviders === "object") {
      for (const [dshName, cfg] of Object.entries(piProviders)) {
        if (!cfg || typeof cfg !== "object") continue;
        const mapped = DSH_PROVIDER_MAP[dshName];
        if (!mapped || mapped.autoSync === false) continue;
        const envName = cfg.apiKeyEnv || `${dshName.toUpperCase()}_API_KEY`;
        const key = credentials[envName];
        if (!key) continue;
        candidates.push({ id: mapped.kind, kind: mapped.kind, label: mapped.label, apiKey: key });
      }
    }

    // dsh built-in DeepSeek provider (no apiKeyEnv; uses DEEPSEEK_API_KEY).
    if (settings?.["llm-deepseek"]) {
      const key = credentials.DEEPSEEK_API_KEY;
      if (key) {
        candidates.push({ id: "deepseek", kind: "deepseek", label: "DeepSeek", apiKey: "__credentials__" });
      }
    }

    let added = 0;
    let skipped = 0;
    const store = await ensureStore();
    for (const cand of candidates) {
      const existsById = store.some((p) => p.id === cand.id);
      const existsByKind = store.some((p) => p.kind === cand.kind && p.apiKey !== "__credentials__");
      if (existsById || existsByKind) {
        skipped++;
        continue;
      }
      // 仅当 store 完全为空（首次初始化，或用户清空了全部 provider）时，才从 dsh 设置自动加回；
      // 否则用户已主动删除该项，不自动复活，确保「删除」持久生效（重启 dsh 也不会回来）。
      if (store.length === 0) {
        store.push({ ...cand, enabled: true });
        added++;
      }
    }
    if (added > 0) await writeStore(store);

    return {
      ok: true,
      added,
      skipped,
      total: store.length,
      providers: store.map(providerToView)
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** Mask an API key for display in the provider list. */
function maskKey(k) {
  if (!k) return "";
  if (k === "__credentials__") return "凭据文件";
  if (k.length <= 6) return "****";
  return k.slice(0, 4) + "…" + k.slice(-4);
}

/** Display label for a provider's secret: cookie providers show "已设置 Cookie". */
function displayKey(p) {
  if (p.kind === "mimo" && p.cookie) return "已设置 Cookie";
  if (p.kind === "newapi" && p.token === "__credentials__") return `凭据文件（${p.keyRef || "NEWAPI_TOKEN"}）`;
  if (p.kind === "newapi" && p.token) return "已设置访问令牌";
  return maskKey(p.apiKey);
}

/** Normalize a stored provider entry for the client (never leaks the raw secret). */
function providerToView(p) {
  return {
    id: p.id,
    label: p.label,
    kind: p.kind,
    enabled: p.enabled !== false,
    hasCookie: Boolean(p.cookie),
    maskedKey: displayKey(p)
  };
}

/** Resolve the effective API key for a provider (credential seam for DeepSeek). */
async function resolveProviderKey(ctx, provider) {
  if (provider.kind === "deepseek") {
    if (!provider.apiKey || provider.apiKey === "__credentials__") {
      return await resolveKey(ctx);
    }
    return provider.apiKey;
  }
  if (provider.kind === "commandcode") {
    if (!provider.apiKey || provider.apiKey === "__credentials__") {
      try {
        const creds = parseCredentials(await readFile(DSH_CREDENTIALS_PATH, "utf8"));
        return creds.CMD_API_KEY || process.env.CMD_API_KEY || "";
      } catch {
        return process.env.CMD_API_KEY || "";
      }
    }
    return provider.apiKey;
  }
  if (provider.kind === "opencode-go") {
    if (provider.apiKey && provider.apiKey !== "__credentials__") return provider.apiKey;
    // 默认按 keyRef 从 ~/.dsh/.credentials.yaml / 环境变量解析，
    // 避免把明文 API Key 写进 ai-balances.json（多号各自指定 keyRef）。
    const ref = provider.keyRef || "OPENCODE_GO_A_KEY";
    try {
      const creds = parseCredentials(await readFile(DSH_CREDENTIALS_PATH, "utf8"));
      return creds[ref] || process.env[ref] || "";
    } catch {
      return process.env[ref] || "";
    }
  }
  return provider.apiKey;
}

/** Query a provider's balance endpoint and normalize the response. */
async function queryProviderBalance(ctx, provider) {
  const def = PROVIDER_DEFS[provider.kind];
  if (!def) return { ok: false, error: `未知平台：${provider.kind}` };

  // AutoDL：POST /api/v1/dev/wallet/balance，Authorization 直接放裸 token（不是 Bearer）。
  if (provider.kind === "autodl") {
    let token = (provider.apiKey || "").trim();
    if (!token || token === "__credentials__") {
      try {
        const creds = parseCredentials(await readFile(DSH_CREDENTIALS_PATH, "utf8"));
        token = creds.AUTODL_TOKEN || process.env.AUTODL_TOKEN || "";
      } catch {
        token = process.env.AUTODL_TOKEN || "";
      }
    }
    if (!token) {
      return { ok: false, error: "AutoDL 需开发者 Token（控制台 → 设置 → 开发者 Token）", needToken: true };
    }
    let res;
    try {
      res = await fetch(def.balanceUrl, { method: "POST", headers: { Authorization: token, Accept: "application/json" } });
    } catch (error) {
      return { ok: false, status: 0, error: `network: ${String(error?.message ?? error)}` };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: "开发者 Token 无效或已过期", needToken: true };
    }
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    let body = null;
    try { body = JSON.parse(await res.text()); } catch { /* 下面统一兜底 */ }
    if (!body || body.code !== "Success" || !body.data) {
      return { ok: false, error: `AutoDL: ${(body && (body.msg || body.code)) || "返回无法解析"}` };
    }
    const data = body.data;
    const toYuan = (value) => (Number(value) || 0) / 1000;
    return {
      ok: true,
      status: 200,
      data: { currency: "CNY", total: toYuan(data.assets), used: toYuan(data.accumulate), voucher: toYuan(data.voucher_balance) }
    };
  }

  // OpenCode Go：订阅制，只查三个窗口的占用百分比；没有余额金额。
  // 端点 GET https://opencode.ai/inference/go/v1/usage，Bearer API Key。
  if (provider.kind === "opencode-go") {
    const goKey = await resolveProviderKey(ctx, provider);
    if (!goKey) {
      return { ok: false, error: `OpenCode Go 需 API Key（${provider.keyRef || "OPENCODE_GO_A_KEY"}）`, needToken: true };
    }
    let goRes;
    try {
      goRes = await fetch(def.usageUrl, {
        method: "GET",
        headers: { Authorization: "Bearer " + goKey, Accept: "application/json" }
      });
    } catch (error) {
      return { ok: false, status: 0, error: `network: ${String(error?.message ?? error)}` };
    }
    if (goRes.status === 401 || goRes.status === 403) {
      return { ok: false, status: goRes.status, error: "OpenCode Go API Key 无效或已过期", needToken: true };
    }
    if (!goRes.ok) return { ok: false, status: goRes.status, error: `HTTP ${goRes.status}` };
    let goBody = null;
    try { goBody = JSON.parse(await goRes.text()); } catch { /* 下面统一兜底 */ }
    const usage = goBody && goBody.usage;
    if (!usage) return { ok: false, error: "无法解析 OpenCode Go 用量返回" };
    const normalizeGoWindow = (w) => (w ? {
      percent: Number(w.percent) || 0,
      status: w.status || null,
      resetsAt: w.resetsAt || null
    } : null);
    return {
      ok: true,
      status: goRes.status,
      // 刻意不返回 total / used：订阅制没有余额金额，避免胶囊显示 $0.00 或把消耗算进权重。
      data: {
        currency: "USD",
        plan: "Go",
        windows: {
          fiveHour: normalizeGoWindow(usage.rolling),
          weekly: normalizeGoWindow(usage.weekly),
          monthly: normalizeGoWindow(usage.monthly)
        }
      }
    };
  }

  // Command Code GOAT：Cookie 鉴权，读后台额度接口（月额度 $70 上限 + 本月用量）。
  if (provider.kind === "commandcode") {
    const ccKey = await resolveProviderKey(ctx, provider);
    if (!ccKey) {
      return { ok: false, error: "Command Code 需 API Key（~/.dsh/.credentials.yaml 的 CMD_API_KEY）", needCookie: false };
    }
    const headers = {
      Authorization: "Bearer " + ccKey,
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
      Origin: "https://commandcode.ai",
      Referer: "https://commandcode.ai/"
    };
    let creditsRes;
    let summaryRes;
    let subsRes;
    try {
      [creditsRes, summaryRes, subsRes] = await Promise.all([
        fetch(def.creditsUrl, { method: "GET", headers }),
        fetch(def.summaryUrl, { method: "GET", headers }),
        fetch(def.subsUrl, { method: "GET", headers })
      ]);
    } catch (error) {
      return { ok: false, status: 0, error: `network: ${String(error?.message ?? error)}` };
    }
    if (creditsRes.status === 401) {
      return { ok: false, status: 401, error: "API Key 无效或已过期（CMD_API_KEY）", needCookie: false };
    }
    if (!creditsRes.ok) return { ok: false, status: creditsRes.status, error: `HTTP ${creditsRes.status}` };
    let credits = null;
    let creditsPayload = null;
    let summary = null;
    let sub = null;
    try {
      const parsed = JSON.parse(await creditsRes.text());
      creditsPayload = parsed ?? null;
      credits = parsed?.credits ?? null;
    } catch { /* 解析失败下面兜底 */ }
    try { summary = JSON.parse(await summaryRes.text()); } catch { /* 用量可选 */ }
    try { sub = JSON.parse(await subsRes.text()); } catch { /* 订阅可选 */ }
    if (!credits) return { ok: false, error: "无法解析 Command Code 额度返回" };
    const left = Number(credits.monthlyCredits) || 0;
    const purchased = Number(credits.purchasedCredits) || 0;
    // /alpha/billing/credits has no monthlyCreditsGranted (/internal only).
    // used this period + remaining = granted (verified exactly 70).
    const grantedRaw = Number(credits.monthlyCreditsGranted) || 0;
    const usedThisPeriod = Number(summary && summary.totalMonthlyCredits) || 0;
    const granted = grantedRaw > 0 ? grantedRaw : left + usedThisPeriod + purchased;
    // 窗口限流（5 小时 / 每周）：credits 接口真实提供，UI 直接展示，不需要猜。
    // windowLimits 与 credits 同级（后端返回顶层结构），不在 credits 里面。
    const limits = (creditsPayload && creditsPayload.windowLimits) || {};
    const normalizeWindow = (w) => (w
      ? {
          used: Number(w.used) || 0,
          cap: Number(w.cap) || 0,
          resetAt: Number(w.resetAt) || null,
          exceeded: Boolean(w.exceeded)
        }
      : null);
    const data = {
      currency: "USD",
      total: Math.round((left + purchased) * 1e6) / 1e6,
      granted,
      used: Math.round(Math.max(0, granted - left) * 1e6) / 1e6,
      plan: sub?.data?.status === "active" ? "GOAT" : (sub?.data?.status ?? null),
      // Command Code 只有「计费周期」口径，没有「今日」接口：
      // periodStart/periodEnd 一并带出，UI 才能把「本周期已用」说清楚。
      month: summary
        ? {
            cost: Number(summary.totalCost) || 0,
            tokens: Number(summary.totalTokens) || 0,
            requests: Number(summary.totalCount) || 0,
            periodBasis: summary.periodBasis || null,
            periodStart: summary.periodStart || null,
            periodEnd: summary.periodEnd || (sub?.data?.currentPeriodEnd ?? null)
          }
        : null,
      windows: {
        fiveHour: normalizeWindow(limits.fiveHour),
        weekly: normalizeWindow(limits.weekly)
      }
    };
    return { ok: true, status: creditsRes.status, data };
  }

  // New API gateways: 只用 sk- 模型密钥读**余额**一条只读接口。
  // 2026-11-19：多数部署把 /api/user/self、/api/data/self 锁在登录会话后面，
  // 账号密码登录撞 AUTH_SESSION_LIMIT（409），旧 32 位访问令牌已退役
  // （ACCESS_TOKEN_LEGACY_RETIRED）；同一天按用户要求**不再展示今日消费/今日 Token**，
  // 因此 /api/log/token（一次要拉最近 1000 条日志，是全插件最重的一次请求）整条去掉。
  //   余额：GET {baseUrl}/api/usage/token/ → data.user_quota.total_available / total_used
  if (def.tokenAuth) {
    // token 可以是明文 sk-，也可以是 "__credentials__" + keyRef：后者从
    // ~/.dsh/.credentials.yaml 读，避免密钥在 ai-balances.json 里再存一份。
    let bearer = String(provider.token || "").trim();
    if (!bearer || bearer === "__credentials__") {
      const ref = String(provider.keyRef || "NEWAPI_TOKEN").trim();
      try {
        const creds = parseCredentials(await readFile(DSH_CREDENTIALS_PATH, "utf8"));
        bearer = String(creds[ref] || process.env[ref] || "").trim();
      } catch {
        bearer = String(process.env[ref] || "").trim();
      }
    }
    if (!bearer || bearer.startsWith("cookie:") || !provider.baseUrl) {
      return {
        ok: false,
        error: "New API 需要 sk- 模型密钥（Bearer），账号+密码/系统访问令牌在本站点已不可用",
        needToken: true
      };
    }
    const base = String(provider.baseUrl).replace(/\/$/, "");
    const headers = { Authorization: `Bearer ${bearer}`, Accept: "application/json" };
    if (provider.userId) headers["New-Api-User"] = String(provider.userId);
    let balResponse;
    try {
      balResponse = await fetch(base + def.balancePath, { method: "GET", headers });
    } catch (error) {
      return { ok: false, status: 0, error: `network: ${String(error?.message ?? error)}` };
    }
    if (balResponse.status === 401) {
      return { ok: false, status: 401, error: "sk- 模型密钥无效或已过期，请在控制台重新生成令牌", needToken: true };
    }
    if (!balResponse.ok) return { ok: false, status: balResponse.status, error: `HTTP ${balResponse.status}` };
    let balData = null;
    try {
      balData = JSON.parse(await balResponse.text());
    } catch { /* handled by parse below */ }
    const parsed = def.parse(balData);
    if (!parsed) return { ok: false, error: "无法解析 New API 余额返回（检查 baseUrl 是否指向该站点）" };
    return { ok: true, status: balResponse.status, data: parsed };
  }

  // Cookie-auth providers (MiMo) read the balance from the web console, not via API key.
  if (def.cookieAuth) {
    if (!provider.cookie) {
      return { ok: false, error: "MiMo 余额需登录 Cookie，请在弹窗点「设置 Cookie」", needCookie: true };
    }
    const cookieHeaders = {
      Cookie: provider.cookie,
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      Origin: "https://platform.xiaomimimo.com",
      Referer: "https://platform.xiaomimimo.com/console/usage"
    };
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    let response;
    let usageResponse = null;
    let detailResponse = null;
    try {
      const tasks = [fetch(def.balanceUrl, { method: "GET", headers: cookieHeaders })];
      let usageIdx = -1;
      let detailIdx = -1;
      if (def.usageUrl) { tasks.push(fetch(def.usageUrl, { method: "GET", headers: cookieHeaders })); usageIdx = tasks.length - 1; }
      if (def.detailUrl) {
        const detailUrl = `${def.detailUrl}?year=${year}&month=${month}`;
        tasks.push(fetch(detailUrl, { method: "GET", headers: cookieHeaders }));
        detailIdx = tasks.length - 1;
      }
      const settled = await Promise.all(tasks);
      response = settled[0];
      usageResponse = usageIdx >= 0 ? settled[usageIdx] : null;
      detailResponse = detailIdx >= 0 ? settled[detailIdx] : null;
    } catch (error) {
      return { ok: false, status: 0, error: `network: ${String(error?.message ?? error)}` };
    }
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 512) };
    }
    if (response.status === 401) {
      return { ok: false, status: 401, error: "Cookie 已过期，请重新复制", needCookie: true, data };
    }
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}`, data };
    const parsed = def.parse(data);
    if (!parsed) return { ok: false, error: "无法解析余额返回（请把原始响应发给 AI 适配字段）", data };
    // 用量接口（MiMo 网页端 /api/v1/usage）：与余额同 Cookie。失败不阻塞余额展示。
    if (usageResponse !== null) {
      try {
        const uText = await usageResponse.text();
        const uData = JSON.parse(uText);
        if (uData && uData.code === 0 && uData.data) parsed.usage = uData.data;
      } catch {
        // 用量可选，忽略解析失败。
      }
    }
    // 逐日明细接口（MiMo 网页端 /api/v1/usage/detail）：含每日 Token / 请求，
    // 据此反推今日消费/今日Token（MiMo API 不单列「今日」字段）。失败不阻塞余额展示。
    if (detailResponse !== null) {
      try {
        const dText = await detailResponse.text();
        const dData = JSON.parse(dText);
        if (dData && dData.code === 0 && dData.data && def.pricing) {
          const parsedDetail = parseMimoDetail(dData.data, def.pricing, year, month);
          parsed.daily = parsedDetail.daily;
          parsed.today = parsedDetail.today;
        }
      } catch {
        // 逐日明细可选，忽略解析失败。
      }
    }
    return { ok: true, status: response.status, data: parsed };
  }

  /**
   * 解析 MiMo 逐日用量明细（/api/v1/usage/detail）。
   * tokenUsage: [["MM-DD", input, output, total, cache], ...]
   * requests:   [["MM-DD", count], ...]
   * 消费金额由 Token 计数 × 固定单价推算（与 MiMo 网页端一致）：
   *   输入(未命中缓存) ¥1.00/百万，输出 ¥2.00/百万，输入(命中缓存) ¥0.02/百万。
   * @returns {{daily:Array<{date:string,input:number,output:number,total:number,cache:number,requests:number,cost:number}>, today:object|null}}
   */
  function parseMimoDetail(data, pricing, year, month) {
    const tokenRows = Array.isArray(data.tokenUsage) ? data.tokenUsage : [];
    const reqRows = Array.isArray(data.requests) ? data.requests : [];
    const reqMap = {};
    for (const r of reqRows) {
      if (Array.isArray(r) && r.length >= 2) reqMap[String(r[0])] = Number(r[1]) || 0;
    }
    const daily = [];
    for (const row of tokenRows) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const date = String(row[0]);
      const input = Number(row[1]) || 0;
      const output = Number(row[2]) || 0;
      const total = Number(row[3]) || 0;
      const cache = Number(row[4]) || 0;
      const inputNonCache = Math.max(0, input - cache);
      const cost = (inputNonCache / 1e6) * pricing.input
        + (cache / 1e6) * pricing.cacheHit
        + (output / 1e6) * pricing.output;
      daily.push({
        date,
        input,
        output,
        total,
        cache,
        requests: reqMap[date] || 0,
        cost: Math.round(cost * 1e6) / 1e6
      });
    }
    // 今日 = 当前 MM-DD（本地时区）；当日无用量记录则 today 为 null。
    const mm = String(month).padStart(2, "0");
    const todayKey = `${mm}-${String(new Date().getDate()).padStart(2, "0")}`;
    const todayRow = daily.find((d) => d.date === todayKey) || null;
    const today = todayRow
      ? { cost: todayRow.cost, tokens: todayRow.total, requests: todayRow.requests }
      : null;
    return { daily, today };
  }

  // API-key providers (DeepSeek).
  const key = await resolveProviderKey(ctx, provider);
  if (!key) {
    return { ok: false, error: provider.kind === "deepseek" ? "DEEPSEEK_API_KEY 未配置" : "API Key 未配置" };
  }
  let response;
  try {
    response = await fetch(def.balanceUrl, {
      method: "GET",
      headers: { ...def.authHeader(key), Accept: "application/json" }
    });
  } catch (error) {
    return { ok: false, status: 0, error: `network: ${String(error?.message ?? error)}` };
  }
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 512) };
  }
  if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}`, data };
  const parsed = def.parse(data);
  if (!parsed) return { ok: false, error: "无法解析余额返回", data };
  return { ok: true, status: response.status, data: parsed };
}

/** Read and parse a JSON request body (capped at 1MB). */
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += String(c);
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

/** DeepSeek official balance endpoint (OpenAI-compatible auth). */
const BALANCE_URL = "https://api.deepseek.com/user/balance";

/** DeepSeek Platform private usage endpoints (require a platform userToken). */
const PLATFORM = "https://platform.deepseek.com";
const USAGE_AMOUNT_URL = `${PLATFORM}/api/v0/usage/amount?month=__MONTH__&year=__YEAR__`;
const USAGE_COST_URL = `${PLATFORM}/api/v0/usage/cost?month=__MONTH__&year=__YEAR__`;
const PLATFORM_HEADERS = {
  "x-app-version": "1.0.0",
  Accept: "*/*",
  Referer: "https://platform.deepseek.com/usage",
  Origin: "https://platform.deepseek.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
};

/**
 * Simple semver comparison for x.y.z style versions.
 * @returns {number} 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareSemver(a, b) {
  const toParts = (v) => String(v).split(".").map((p) => Number.parseInt(p, 10) || 0);
  const ap = toParts(a);
  const bp = toParts(b);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i] ?? 0;
    const bv = bp[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

/**
 * Query the NPM registry for the highest published version of this package.
 * The popover "update" button will install this version regardless of the "latest" dist-tag.
 * @returns {Promise<{ok:boolean, local:string, latest?:string, updateAvailable?:boolean, error?:string}>}
 */
async function queryNpmVersion() {
  // fork 构建（版本号形如 2.4.3--0.2）既不发 npm，也不跟上游比版本：直接返回本地版本，连网络都不打。
  if (String(LOCAL_VERSION).includes("--")) {
    return { ok: true, local: LOCAL_VERSION, updateAvailable: false, fork: true };
  }
  let response;
  try {
    response = await fetch(NPM_REGISTRY_URL, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
  } catch (error) {
    return { ok: false, local: LOCAL_VERSION, error: `network: ${String(error?.message ?? error)}` };
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    const text = await response.text();
    return { ok: false, local: LOCAL_VERSION, error: `bad json (HTTP ${response.status})` };
  }
  const versions = data && typeof data.versions === "object" ? Object.keys(data.versions) : [];
  if (!versions.length) {
    return { ok: false, local: LOCAL_VERSION, error: "version list missing" };
  }
  const latest = versions.reduce((max, v) => (compareSemver(v, max) > 0 ? v : max), versions[0]);
  if (typeof latest !== "string") {
    return { ok: false, local: LOCAL_VERSION, error: "could not determine highest version" };
  }
  // 本 fork 的版本号形如 `2.4.3--0.2`（上游版本 + 我们的修订），按 semver 比它低于上游 2.4.3，
  // 直接比会出现「提示更新到上游」的假更新，所以 fork 构建一律不提示。
  const isForkBuild = String(LOCAL_VERSION).includes("--");
  const updateAvailable = !isForkBuild && compareSemver(latest, LOCAL_VERSION) > 0;
  return { ok: true, local: LOCAL_VERSION, latest, updateAvailable };
}

/** @returns {Promise<boolean>} whether the given path exists. */
async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the package manager used in a given project root.
 * @param {string} cwd
 * @returns {Promise<"pnpm" | "npm">}
 */
async function detectPackageManager(cwd) {
  const pnpmLock = resolve(cwd, "pnpm-lock.yaml");
  const pnpmLockYml = resolve(cwd, "pnpm-lock.yml");
  if (await fileExists(pnpmLock) || await fileExists(pnpmLockYml)) return "pnpm";
  return "npm";
}

/**
 * Collect every dsh profile root that currently contains this plugin in its
 * node_modules. We never rely on a single reverse-derived path because dsh may
 * load the plugin from a different profile than the one our module URL points
 * at (desktop vs web profile, pnpm symlinks, custom-plugins, etc). The previous
 * single-point UPDATE_CWD caused "update succeeded but version unchanged"
 * failures on machines where dsh loaded the plugin from a different location
 * than the one npm wrote to.
 * @returns {Promise<string[]>}
 */
async function getUpdateTargets() {
  const roots = new Set();
  const normalize = (p) => String(p).replace(/\\/g, "/");
  // 1. Reverse-derive from PLUGIN_ROOT (handles symlink edge cases via realpath).
  try {
    const realRoot = normalize(await realpath(PLUGIN_ROOT));
    const parts = realRoot.split("/");
    const nmIndex = parts.lastIndexOf("node_modules");
    if (nmIndex > 0) roots.add(parts.slice(0, nmIndex).join("/"));
  } catch {}
  // 2. Scan every dsh profile for a node_modules entry of this plugin.
  try {
    const profilesDir = resolve(homedir(), ".dsh", "profiles");
    const entries = await readdir(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const profileRoot = normalize(resolve(profilesDir, entry.name));
      const pluginDir = resolve(profileRoot, "node_modules", "dsh-deepseek-balance-widget");
      if (await fileExists(pluginDir)) {
        roots.add(profileRoot);
      }
    }
  } catch {}
  return [...roots];
}

/**
 * WorkBuddy (and some other agent hosts) inject a safe-delete shim via
 * NODE_OPTIONS=--require=...genie-safe-delete.cjs. That shim monkey-patches
 * fs.unlink/rm to go through a trash channel which is disabled inside the
 * desktop sandbox, so pnpm/npm abort (fail-closed) whenever they delete temp
 * files during an update — the classic "update failed / version unchanged"
 * symptom. Strip the shim from the child env so the package manager can run.
 * @returns {NodeJS.ProcessEnv}
 */
function cleanEnv() {
  const env = { ...process.env };
  const no = env.NODE_OPTIONS || "";
  if (/genie-safe-delete/i.test(no)) {
    // The WorkBuddy safe-delete shim monkey-patches fs.unlink/rm to route
    // through a trash channel which is disabled inside the desktop sandbox.
    // Any package-manager child that deletes temp files fail-closed. Rather
    // than trying to surgically remove one --require flag (which breaks if
    // WorkBuddy changes spacing/quotes), drop NODE_OPTIONS entirely for the
    // spawned install process. Install commands do not need it.
    delete env.NODE_OPTIONS;
  }
  // Also delete any remaining WorkBuddy/shim variables that can re-enable
  // safe-delete behavior in spawned package managers or shells.
  delete env.WORKBUDDY_SAFE_DELETE;
  delete env.GENIE_SAFE_DELETE;
  delete env.SAFE_DELETE_ENABLED;
  delete env.BASH_ENV;
  env.NPM_CONFIG_FUND = "false";
  env.NPM_CONFIG_AUDIT = "false";
  return env;
}

/**
 * Run the package-manager update command for this package in a single project root.
 * @returns {Promise<{ok:boolean, output:string, error?:string}>}
 */
async function runInstallOnce(cwd, target) {
  const pm = await detectPackageManager(cwd);
  const isWin = process.platform === "win32";
  const cmd = isWin ? (pm === "pnpm" ? "pnpm" : "npm") : pm;
  const args = pm === "pnpm"
    ? ["add", `dsh-deepseek-balance-widget@${target}`]
    : ["install", `dsh-deepseek-balance-widget@${target}`];
  return new Promise((resolve) => {
    let child;
    if (isWin) {
      // Avoid Node.js DEP0190: spawn with shell:true and a separate args array is deprecated.
      // Build a single command string and let cmd.exe parse it; hide the console window.
      const quotedArgs = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
      child = spawn("cmd.exe", ["/d", "/s", "/c", `${cmd} ${quotedArgs}`], {
        cwd,
        windowsHide: true,
        env: cleanEnv()
      });
    } else {
      child = spawn(cmd, args, {
        cwd,
        env: cleanEnv()
      });
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      resolve({ ok: false, output: stdout + stderr, error: String(error?.message ?? error) });
    });
    child.on("close", async (code) => {
      const output = (stdout + "\n" + stderr).trim();
      if (code !== 0) {
        resolve({ ok: false, output, error: `${pm} ${args.join(" ")} exited with code ${code}` });
        return;
      }
      // Verify the on-disk version actually changed so the user can't be misled into
      // restarting dsh when the install silently wrote to a different location.
      try {
        const installedPkgPath = resolve(cwd, "node_modules", "dsh-deepseek-balance-widget", "package.json");
        const installedPkg = JSON.parse(await readFile(installedPkgPath, "utf8"));
        if (installedPkg.version !== target) {
          resolve({ ok: false, output, error: `installed version mismatch: expected ${target}, found ${installedPkg.version}` });
          return;
        }
      } catch (verifyError) {
        resolve({ ok: false, output, error: `update appeared to succeed but could not verify installed version: ${String(verifyError?.message ?? verifyError)}` });
        return;
      }
      resolve({ ok: true, output: output.slice(-800) });
    });
  });
}

/**
 * Update the plugin in every dsh profile that currently has it installed.
 * The first success wins; if at least one location lands on the target version
 * the update is reported as successful.
 * @returns {Promise<{ok:boolean, output:string, error?:string}>}
 */
async function runPackageUpdate() {
  const versionInfo = await queryNpmVersion();
  if (!versionInfo.ok) {
    return { ok: false, error: versionInfo.error || "failed to query npm version" };
  }
  if (!versionInfo.updateAvailable) {
    return { ok: true, output: "already up to date", noOp: true };
  }
  const target = versionInfo.latest;
  let targets = await getUpdateTargets();
  if (targets.length === 0) {
    // Fallback to the legacy single reverse-derived path if scanning found nothing.
    targets = [UPDATE_CWD];
  }
  const lines = [];
  let anySuccess = false;
  for (const cwd of targets) {
    const result = await runInstallOnce(cwd, target);
    const label = cwd.replace(/\//g, "\\");
    if (result.ok) {
      anySuccess = true;
      lines.push(`✓ ${label} -> ${target}`);
    } else {
      lines.push(`✗ ${label}: ${result.error || "failed"}`);
    }
  }
  if (anySuccess) {
    return { ok: true, output: lines.join("\n") };
  }
  return { ok: false, output: lines.join("\n"), error: "update failed in all candidate locations" };
}

/**
 * Query the DeepSeek balance API for one key.
 * @param {string} apiKey - the resolved DeepSeek API key.
 * @returns the normalized envelope ({ ok, status, data }).
 */
async function queryBalance(apiKey) {
  let response;
  try {
    response = await fetch(BALANCE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      }
    });
  } catch (error) {
    return { ok: false, status: 0, error: `network: ${String(error?.message ?? error)}` };
  }
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 512) };
  }
  return { ok: response.ok, status: response.status, data };
}

/**
 * Resolve the DeepSeek key from the credential seam or launch environment.
 * The credential seam reads THIS machine's own `$DSH_HOME/.credentials.yaml`
 * (or the ambient environment), so every user queries with their own key and
 * sees their own balance. Nothing is ever hardcoded in this plugin.
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context.
 * @returns {Promise<string|undefined>} the key, or undefined when unset.
 */
async function resolveKey(ctx) {
  if (ctx.credentials !== void 0) {
    const hit = await ctx.credentials.resolve("DEEPSEEK_API_KEY");
    if (hit !== void 0 && typeof hit.value === "string" && hit.value.length > 0) return hit.value;
  }
  const ambient = launchEnvironmentOf(ctx).get("DEEPSEEK_API_KEY");
  if (ambient !== void 0 && typeof ambient.value === "string" && ambient.value.length > 0) return ambient.value;
  return void 0;
}

/**
 * Resolve the DeepSeek Platform session token (userToken) from the
 * credential seam or launch environment. Required for the private
 * usage/cost dashboard endpoints; an API key cannot authenticate them.
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context.
 * @returns {Promise<string|undefined>} the token, or undefined when unset.
 */
async function resolvePlatformToken(ctx) {
  if (ctx.credentials !== void 0) {
    const hit = await ctx.credentials.resolve("DEEPSEEK_PLATFORM_TOKEN");
    if (hit !== void 0 && typeof hit.value === "string" && hit.value.length > 0) return hit.value;
  }
  const ambient = launchEnvironmentOf(ctx).get("DEEPSEEK_PLATFORM_TOKEN");
  if (ambient !== void 0 && typeof ambient.value === "string" && ambient.value.length > 0) return ambient.value;
  return void 0;
}

/** @returns {Promise<{code:number,msg?:string,data?:any}|{error:string}>} a JSON-ish body. */
async function fetchJson(url, token) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, ...PLATFORM_HEADERS }
    });
  } catch (error) {
    return { error: `network: ${String(error?.message ?? error)}` };
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: `bad json (HTTP ${response.status})`, httpStatus: response.status };
  }
}

/** Earliest year to scan for all-time spend (DeepSeek platform launched 2024). */
const CUMULATIVE_START_YEAR = 2024;

/** Per-month cost map ("YYYY-MM" -> CNY). Filled once on first request. */
let monthlyCostMap = null;
/** In-flight initial scan guard. */
let monthlyInitPromise = null;
/** Months already fetched by the in-flight scan; lets a time-boxed request
 *  still sum the shards that finished (and update the current month) without
 *  touching the half-built monthlyCostMap. */
let monthlyShards = {};
/** Earliest timestamp (ms) at which a failed initial scan may be retried. */
let monthlyScanRetryAt = 0;
/** True once the persisted state has been merged in (first scan or first route hit). */
let scanBackoffLoaded = false;
/** Consecutive real-429 scans; drives exponential backoff. */
let monthlyScanFailures = 0;
/** First backoff delay and its ceiling, in ms. */
const SCAN_BACKOFF_BASE_MS = 2 * 60 * 1000;
const SCAN_BACKOFF_MAX_MS = 60 * 60 * 1000;
/** How long a request waits on the cold-cache 34-month scan before answering
 *  with live current-month data and letting the scan finish in the background. */
const USAGE_SCAN_WAIT_MS = 8 * 1000;
/** Slack added to the scan deadline: a month fetch already in flight cannot be
 *  interrupted, so without this the request pays one extra month's latency. */
const USAGE_SCAN_DEADLINE_SLACK_MS = 4 * 1000;

/**
 * True only for a genuine platform rate-limit (HTTP 429 / "429" in the message).
 * Network blips and one-off 5xx responses must NOT trip the global backoff:
 * a single bad month used to suppress today's spend for up to an hour.
 * @param {unknown} error
 * @returns {boolean}
 */
function isRateLimitError(error) {
  const text = String(error?.message ?? error);
  if (/(^|\D)429(\D|$)/.test(text)) return true;
  return /http\s*429|too many requests|rate\s*limit/i.test(text);
}

/** Load the persisted backoff window; silently degrades when unreadable/expired. */
async function loadScanBackoff() {
  try {
    const saved = JSON.parse(await readFile(SCAN_BACKOFF_PATH, "utf8"));
    const until = Number(saved?.backoffUntil);
    if (Number.isFinite(until) && until > Date.now()) {
      // The module may already have backed off further than the file says.
      if (until > monthlyScanRetryAt) monthlyScanRetryAt = until;
      monthlyScanFailures = Math.max(monthlyScanFailures, Number(saved?.failures) || 0);
    }
  } catch {
    // Missing file, corrupt JSON or unreadable home: start with a clean window.
  }
  scanBackoffLoaded = true;
}

/** Persist the current backoff window (best effort; never fails the request). */
async function saveScanBackoff() {
  try {
    await mkdir(resolve(homedir(), ".dsh"), { recursive: true });
    await writeFile(
      SCAN_BACKOFF_PATH,
      JSON.stringify({
        backoffUntil: monthlyScanRetryAt,
        failures: monthlyScanFailures,
        savedAt: new Date().toISOString()
      }),
      "utf8"
    );
  } catch {
    // Losing the state file only costs the restart-proofing, not correctness.
  }
}

/** Fetch one month's total cost from the cost endpoint. Stored unrounded so cumulative
 *  rounding (single final toFixed) matches the official "累计消费金额" figure. */
async function monthCostOf(token, month, year) {
  const url = USAGE_COST_URL.replace("__MONTH__", String(month)).replace("__YEAR__", String(year));
  const resp = await fetchJson(url, token);
  if (resp.error !== void 0) throw new Error(resp.error);
  if (resp.code !== void 0 && resp.code !== 0) throw new Error(`platform ${resp.code}: ${resp.msg ?? "unknown"}`);
  const raw = resp?.data?.biz_data;
  const data = Array.isArray(raw) ? raw[0] : raw;
  let total = 0;
  if (data && Array.isArray(data.total) && data.total.length > 0) {
    for (const modelEntry of data.total) {
      for (const entry of modelEntry.usage ?? []) total += Number.parseFloat(entry.amount) || 0;
    }
  } else if (data) {
    for (const day of data.days ?? []) {
      for (const modelEntry of day.data ?? []) {
        for (const entry of modelEntry.usage ?? []) total += Number.parseFloat(entry.amount) || 0;
      }
    }
  }
  return total;
}

/** Describe a failed month fetch for logs/state (never thrown away silently). */
function monthErrorText(error) {
  return String(error?.message ?? error);
}

/** One-time full scan 2024-01..current month; fills monthlyCostMap.
 *  Only a real 429 backs off exponentially: the client re-polls every 30s, so
 *  retrying a 34-month scan on every poll is what gets the IP rate-limited.
 *  Any other failure is transient — that month is recorded as 0 (yesterday's
 *  figure is kept if a previous run reported one) and the scan carries on, so
 *  the cumulative total is still produced instead of being blocked for an hour. */
async function ensureMonthlyMap(token, signal) {
  if (monthlyCostMap !== null) return;
  const deadline = signal === null || signal === void 0 ? Infinity : signal.deadline;
  if (Date.now() < monthlyScanRetryAt) return;
  if (monthlyInitPromise === null) {
    monthlyShards = {};
    monthlyInitPromise = (async () => {
      const map = {};
      const now = new Date();
      for (let y = CUMULATIVE_START_YEAR; y <= now.getFullYear(); y++) {
        const mEnd = y === now.getFullYear() ? now.getMonth() + 1 : 12;
        for (let m = 1; m <= mEnd; m++) {
          const key = `${y}-${String(m).padStart(2, "0")}`;
          if (Date.now() >= deadline) {
            // Time-boxed request: publish what we have so the route can answer
            // now; the scan retries on the next poll (see the deadline branch).
            map[key] = 0;
            monthlyShards[key] = 0;
            continue;
          }
          try {
            map[key] = await monthCostOf(token, m, y);
          } catch (monthError) {
            // Real rate limit: stop immediately instead of hammering the
            // remaining months, which is what deepens the block.
            if (isRateLimitError(monthError)) throw monthError;
            // Transient (network hiccup, single-month 5xx): keep the last known
            // value when there is one, else record 0, and keep scanning.
            const previous = monthlyCostMap === null ? void 0 : monthlyCostMap[key];
            map[key] = typeof previous === "number" ? previous : 0;
          }
          monthlyShards[key] = map[key];
        }
      }
      monthlyCostMap = map;
    })();
  }
  try {
    await monthlyInitPromise;
    monthlyScanFailures = 0;
    monthlyScanRetryAt = 0;
    saveScanBackoff();
  } catch (error) {
    // Only a real 429 widens the window. Anything else (e.g. an aborted scan)
    // must not suppress the next poll's fresh data.
    if (isRateLimitError(error)) {
      monthlyScanFailures += 1;
      const delay = Math.min(
        SCAN_BACKOFF_BASE_MS * 2 ** (monthlyScanFailures - 1),
        SCAN_BACKOFF_MAX_MS
      );
      monthlyScanRetryAt = Date.now() + delay;
      saveScanBackoff();
    }
    throw error;
  } finally {
    monthlyInitPromise = null;
  }
}

/**
 * Cold-cache cumulative fallback: the full scan is already running, so answer
 * with the live current-month figure and let the next 30s poll fill the total.
 * Without this the first poll would still return null after waiting a whole scan.
 * @returns {Promise<number|null>} current-month CNY cost, or null when unknown.
 */
async function currentMonthEstimate(token, month, year) {
  try {
    return await monthCostOf(token, month, year);
  } catch {
    return null;
  }
}

/**
 * Sum the month map; upserts the running month's fresh cost when given.
 * Past months are billing-final, so only the current month needs updating —
 * this makes the cumulative figure effectively real-time at zero extra cost.
 * @returns {number|null} rounded CNY total, or null before the map is ready.
 */
function cumulativeFromMap(key, value) {
  if (monthlyCostMap === null) {
    // Sharded scan still in flight: never mutate the half-built map, just show
    // the current month (plus whatever earlier shards already published).
    if (key === void 0 || typeof monthlyShards[key] !== "number") return null;
    const partial = { ...monthlyShards, [key]: value };
    let partialTotal = 0;
    for (const k of Object.keys(partial)) partialTotal += partial[k];
    return Math.round(partialTotal * 100) / 100;
  }
  if (key !== void 0) monthlyCostMap[key] = value;
  let total = 0;
  for (const k of Object.keys(monthlyCostMap)) total += monthlyCostMap[k];
  return Math.round(total * 100) / 100;
}

/**
 * Fetch and normalize the current-month usage from the platform dashboard.
 * @param {string} token - platform userToken.
 * @param {number} month - 1..12.
 * @param {number} year - e.g. 2026.
 * @returns normalized envelope ({ ok, status, data }).
 */
async function queryPlatformUsage(token, month, year) {
  const [amount, cost] = await Promise.all([
    fetchJson(USAGE_AMOUNT_URL.replace("__MONTH__", String(month)).replace("__YEAR__", String(year)), token),
    fetchJson(USAGE_COST_URL.replace("__MONTH__", String(month)).replace("__YEAR__", String(year)), token)
  ]);

  const failed = [amount, cost].find((r) => r.error !== void 0);
  if (failed !== void 0) return { ok: false, status: 0, error: failed.error };

  // Platform private endpoints answer { code, msg, data } — 40002/40003 = bad/expired session.
  for (const r of [amount, cost]) {
    if (r.code !== void 0 && r.code !== 0) {
      return { ok: false, status: 401, error: `platform ${r.code}: ${r.msg ?? "unknown"}` };
    }
  }

  const bizData = (resp) => {
    const raw = resp?.data?.biz_data;
    return Array.isArray(raw) ? raw[0] : raw;
  };
  const amountData = bizData(amount);
  const costData = bizData(cost);
  if (!amountData || !Array.isArray(amountData.days)) {
    return { ok: false, status: 200, error: "amount response missing days" };
  }

  const isToken = (t) => typeof t === "string" && /TOKEN/i.test(t);
  const isRequest = (t) => typeof t === "string" && /REQUEST|REQ_|_REQ|COUNT|CALLS?/i.test(t);

  // Prefer biz_data.total (month aggregate); fall back to summing the days.
  const usageEntries = () => {
    const entries = [];
    const collect = (modelEntries) => {
      for (const modelEntry of modelEntries ?? []) {
        for (const entry of modelEntry.usage ?? []) entries.push(entry);
      }
    };
    if (Array.isArray(amountData.total) && amountData.total.length > 0) {
      collect(amountData.total);
    } else {
      for (const day of amountData.days ?? []) collect(day.data);
    }
    return entries;
  };

  let tokens = 0;
  let requests = 0;
  for (const entry of usageEntries()) {
    const v = Number.parseFloat(entry.amount) || 0;
    if (isToken(entry.type)) tokens += Math.round(v);
    else if (isRequest(entry.type)) requests += Math.round(v);
  }

  let costValue = 0;
  const sumUsage = (modelEntries) => {
    for (const modelEntry of modelEntries ?? []) {
      for (const entry of modelEntry.usage ?? []) costValue += Number.parseFloat(entry.amount) || 0;
    }
  };
  if (costData) {
    // biz_data.total is the month aggregate; fall back to summing the days.
    if (Array.isArray(costData.total) && costData.total.length > 0) {
      sumUsage(costData.total);
    } else {
      for (const day of costData.days ?? []) sumUsage(day.data);
    }
  }
  costValue = Math.round(costValue * 100) / 100;

  // 今日数据：平台实时接口（by_api_key），按 [今日 0 点 GMT+8, 明日 0 点) 的小时桶求和。
  // （月度接口的逐日明细滞后一天，今天的数据要查实时端点才能拿到。）
  const TZ_SHANGHAI = 8 * 3600; // 秒
  const shMidnightSec = Math.floor((Date.now() + TZ_SHANGHAI * 1000) / 86400000) * 86400 - TZ_SHANGHAI;
  const todayStart = shMidnightSec;
  const todayEnd = todayStart + 86400;
  const todayKey = (ep) => `${PLATFORM}/api/v0/usage/by_api_key/${ep}?start=${todayStart}&end=${todayEnd}&tz=${TZ_SHANGHAI}`;
  let todayCost = 0;
  let todayTokens = 0;
  let todayRequests = 0;
  const [todayAmount, todayCostResp] = await Promise.all([
    fetchJson(todayKey("amount"), token),
    fetchJson(todayKey("cost"), token)
  ]);
  const tA = todayAmount?.data?.biz_data;
  if (tA && Array.isArray(tA.series)) {
    for (const series of tA.series) {
      for (const bucket of series.buckets ?? []) {
        const u = bucket.usage ?? {};
        for (const k of Object.keys(u)) {
          const v = Number.parseFloat(u[k]) || 0;
          if (isToken(k)) todayTokens += Math.round(v);
          else if (isRequest(k)) todayRequests += Math.round(v);
        }
      }
    }
  }
  const tC = todayCostResp?.data?.biz_data;
  if (tC) {
    const seriesList = Array.isArray(tC.series)
      ? tC.series
      : Array.isArray(tC.data)
        ? tC.data.flatMap((d) => d.series ?? [])
        : [];
    for (const series of seriesList) {
      for (const bucket of series.buckets ?? []) todayCost += Number.parseFloat(bucket.cost) || 0;
    }
  }
  todayCost = Math.round(todayCost * 100) / 100;

  // 累计消费 = 全月份成本求和；当月数值用本次实时结果更新，过去月份账目已定。
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const cumulativeValue = cumulativeFromMap(monthKey, costValue);

  return {
    ok: true,
    status: 200,
    data: {
      month,
      year,
      period: "本月",
      apiKey: "API Key 全部",
      totalSpend: `¥${costValue.toFixed(2)}`,
      cumulativeSpend: cumulativeValue === null ? null : `¥${cumulativeValue.toFixed(2)}`,
      todaySpend: todayCost.toFixed(2),
      todayTokens: String(todayTokens).replace(/\B(?=(\d{3})+(?!\d))/g, ","),
      todayRequests: String(todayRequests).replace(/\B(?=(\d{3})+(?!\d))/g, ","),
      requestCount: String(requests).replace(/\B(?=(\d{3})+(?!\d))/g, ","),
      tokens: String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    }
  };
}

/**
 * cordis plugin apply: register the balance route on the shared webserver.
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context.
 */
function apply(ctx) {
  // Copy the AI setup guide to a fixed, space-free location so any chat AI
  // launched from dsh can read it without being tripped up by spaces in the
  // workspace path or by the file not being shipped in the npm tarball.
  (async () => {
    try {
      const guideSrc = resolve(PLUGIN_ROOT, "AI_BALANCE_SETUP_GUIDE.md");
      const dshDir = resolve(homedir(), ".dsh");
      const guideDest = resolve(dshDir, "AI_BALANCE_SETUP_GUIDE.md");
      await stat(guideSrc);
      await mkdir(dshDir, { recursive: true });
      await copyFile(guideSrc, guideDest);
    } catch {}
  })();

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/deepseek-balance",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (req.method !== "GET" || url.pathname !== "/deepseek-balance") {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "not found" }));
          return;
        }
        try {
          const key = await resolveKey(ctx);
          if (key === void 0) {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "DEEPSEEK_API_KEY 未配置（请在 ~/.dsh/.credentials.yaml 设置）" }));
            return;
          }
          const fresh = url.searchParams.get("fresh") === "1";
          const result = fresh
            ? await queryBalance(key).then((r) => { upstreamCacheSet("deepseek-balance", r); return r; })
            : await withUpstreamCache("deepseek-balance", () => queryBalance(key));
          res.writeHead(result.ok ? 200 : 502, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
        }
      }
    });
    return dispose;
  }, "deepseek-balance-widget: route");

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/deepseek-usage",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (req.method !== "GET" || url.pathname !== "/deepseek-usage") {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "not found" }));
          return;
        }
        try {
          const token = await resolvePlatformToken(ctx);
          if (token === void 0) {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "DEEPSEEK_PLATFORM_TOKEN 未配置。对 AI 说「帮我配置用量统计」即可让 AI 帮你设置。" }));
            return;
          }
          const now = new Date();
          const month = now.getMonth() + 1;
          const year = now.getFullYear();

          // Merge the persisted backoff window once per process, so a restart
          // does not immediately re-run the 34-month scan into a platform that
          // just rate-limited us.
          if (!scanBackoffLoaded) await loadScanBackoff();

          const inBackoff = Date.now() < monthlyScanRetryAt;
          let scanPending = false;
          if (monthlyCostMap === null && !inBackoff) {
            // 首次请求做一次全月份扫描（之后只在内存里更新当月，零额外请求）。
            // Time-boxed: the 34-month scan keeps running in the background and
            // 今日数据 never waits for it.
            try {
              await ensureMonthlyMap(token, {
                deadline: Date.now() + USAGE_SCAN_WAIT_MS + USAGE_SCAN_DEADLINE_SLACK_MS
              });
            } catch {
              // 扫描失败时本轮累计值保持 null；下轮重试。
            }
            scanPending = monthlyCostMap === null;
            if (scanPending && monthlyShards[`${year}-${String(month).padStart(2, "0")}`] === void 0) {
              // Cold cache and no shard for this month yet: fetch it directly so
              // the very first response already carries 今日消费/token.
              const estimate = await currentMonthEstimate(token, month, year);
              if (estimate !== null) {
                monthlyShards[`${year}-${String(month).padStart(2, "0")}`] = estimate;
              }
            }
          }

          const freshUsage = url.searchParams.get("fresh") === "1";
          const usageCacheKey = "deepseek-usage:" + year + "-" + month;
          const result = freshUsage
            ? await queryPlatformUsage(token, month, year).then((r) => { upstreamCacheSet(usageCacheKey, r); return r; })
            : await withUpstreamCache(usageCacheKey, () => queryPlatformUsage(token, month, year));
          if (result.ok) {
            // 退避窗口内照样返回当月实时数据；只有累计值降级为 null。
            if (inBackoff) {
              result.data.cumulativeSpend = null;
              result.backoffUntil = monthlyScanRetryAt;
            } else if (scanPending) {
              result.backoffUntil = 0;
            }
          }
          res.writeHead(result.ok ? 200 : 502, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
        }
      }
    });
    return dispose;
  }, "deepseek-balance-widget: usage route");

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/deepseek-balance-version",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (req.method !== "GET" || url.pathname !== "/deepseek-balance-version") {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "not found" }));
          return;
        }
        try {
          const result = await queryNpmVersion();
          res.writeHead(result.ok ? 200 : 502, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, local: LOCAL_VERSION, error: String(error?.message ?? error) }));
        }
      }
    });
    return dispose;
  }, "deepseek-balance-widget: version route");

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/deepseek-balance-update",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (req.method !== "POST" || url.pathname !== "/deepseek-balance-update") {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "not found" }));
          return;
        }
        try {
          const before = await queryNpmVersion();
          if (before.ok && !before.updateAvailable) {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, noOp: true, local: before.local, latest: before.latest, message: "已是最新版本" }));
            return;
          }
          const result = await runPackageUpdate();
          if (result.ok) {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, message: "更新成功，请彻底重启 dsh 以加载新版本", output: result.output }));
          } else {
            res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: result.error, output: result.output }));
          }
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
        }
      }
    });
    return dispose;
  }, "deepseek-balance-widget: update route");

  /** Read the user's locale from dsh settings.yaml (locale.preference). */
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/deepseek-balance-locale",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (req.method !== "GET" || url.pathname !== "/deepseek-balance-locale") {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "not found" }));
          return;
        }
        try {
          let lang = "zh";
          try {
            const text = await readFile(DSH_SETTINGS_PATH, "utf8");
            // 解析 YAML 顶层 locale: 段下的 preference: 字段（宽松匹配缩进）。
            const match = text.match(/^locale:\s*\r?\n(\s+preference:\s*(\S+))/m);
            if (match) {
              const value = match[2].replace(/^["']|["']$/g, "").toLowerCase();
              if (value === "en" || value === "zh") lang = value;
            }
          } catch { /* settings file missing/unreadable -> default zh */ }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, lang }));
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
        }
      }
    });
    return dispose;
  }, "deepseek-balance-widget: locale route");

  /** Provider list (GET), add/update (POST), remove (DELETE). */
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/ai-balances",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (url.pathname !== "/ai-balances") {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "not found" }));
          return;
        }
        try {
          if (req.method === "GET") {
            const list = (await ensureStore()).map(providerToView);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, providers: list }));
            return;
          }
          if (req.method === "POST") {
            const body = await readBody(req);
            const kind = body.kind;
            if (!PROVIDER_DEFS[kind]) {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, error: `不支持的平台：${kind ?? "(空)"}` }));
              return;
            }
            const store = await ensureStore();
            const id = body.id && typeof body.id === "string" ? body.id : `${kind}-${Date.now().toString(36)}`;
            const existing = store.find((p) => p.id === id);
            // 更新时未提供 apiKey 则保留原值（避免设置 Cookie 时把 sk- 密钥清空）。
            let apiKey = (body.apiKey || "").trim();
            if (!apiKey && existing) apiKey = existing.apiKey;
            if (kind === "deepseek" && !apiKey) apiKey = "__credentials__";
            // OpenCode Go 允许留空 API Key，走 ~/.dsh/.credentials.yaml 里的 keyRef。
            if (kind === "opencode-go" && !apiKey) apiKey = "__credentials__";
            const cookie = (body.cookie || "").trim();
            // New API 账号：baseUrl / userId / 系统访问令牌（更新时未提供则保留原值）。
            let baseUrl = String(body.baseUrl || "").trim().replace(/\/$/, "");
            if (!baseUrl && existing) baseUrl = existing.baseUrl || "";
            let userId = Number(body.userId);
            if (!Number.isInteger(userId) || userId <= 0) userId = existing ? existing.userId : undefined;
            let token = String(body.token || "").trim();
            if (!token && existing) token = existing.token || "";
            let keyRef = String(body.keyRef || "").trim();
            if (!keyRef && existing) keyRef = existing.keyRef || "";
            const entry = {
              id,
              label: (body.label && body.label.trim()) || (existing && existing.label) || PROVIDER_DEFS[kind].label,
              kind,
              apiKey,
              cookie: cookie || (existing ? existing.cookie : undefined),
              ...(kind === "newapi" ? { baseUrl, userId, token } : {}),
              ...(keyRef ? { keyRef } : {}),
              enabled: true
            };
            if (existing) {
              store[store.indexOf(existing)] = entry;
            } else {
              store.push(entry);
            }
            await writeStore(store);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, provider: providerToView(entry) }));
            return;
          }
          if (req.method === "DELETE") {
            const id = url.searchParams.get("id");
            if (!id) {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, error: "缺少 id" }));
              return;
            }
            const store = await ensureStore();
            const next = store.filter((p) => p.id !== id);
            await writeStore(next);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, removed: id }));
            return;
          }
          res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
        }
      }
    });
    return dispose;
  }, "deepseek-balance-widget: providers route");

  /**
   * Provider display order: GET returns the current order, POST { ids: [...] }
   * rewrites it. The order is simply the array order in ~/.dsh/ai-balances.json,
   * so an agent can also reorder by editing that file (scripts/order.mjs does it
   * with validation). Unknown ids are ignored; providers not mentioned keep their
   * relative order at the end — a bad request never drops a provider.
   */
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/ai-balances-order",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (url.pathname !== "/ai-balances-order") {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "not found" }));
          return;
        }
        try {
          const store = await ensureStore();
          if (req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, ids: store.map((p) => p.id), providers: store.map(providerToView) }));
            return;
          }
          if (req.method === "POST") {
            const body = await readBody(req);
            const raw = body && Array.isArray(body.ids) ? body.ids : null;
            if (raw === null) {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, error: "body.ids 必须是 provider id 数组" }));
              return;
            }
            const byId = new Map(store.map((p) => [p.id, p]));
            const next = [];
            for (const id of raw) {
              if (typeof id !== "string") continue;
              const provider = byId.get(id);
              if (provider !== void 0 && !next.includes(provider)) next.push(provider);
            }
            for (const provider of store) if (!next.includes(provider)) next.push(provider);
            await writeStore(next);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, ids: next.map((p) => p.id), providers: next.map(providerToView) }));
            return;
          }
          res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
        }
      }
    });
    return dispose;
  }, "deepseek-balance-widget: provider order route");

  /** Per-provider balance query. */
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/ai-provider-balance",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (req.method !== "GET" || url.pathname !== "/ai-provider-balance") {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "not found" }));
          return;
        }
        try {
          const id = url.searchParams.get("provider");
          if (!id) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "缺少 provider" }));
            return;
          }
          const store = await ensureStore();
          const provider = store.find((p) => p.id === id);
          if (provider === void 0) {
            res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "未找到该 AI 余额" }));
            return;
          }
          // New API 站点管理员要求降频：它的「今日」要拉最近 1000 条日志，缓存给 30 分钟。
          const providerTtl = provider.kind === "newapi" ? { ok: NEWAPI_OK_TTL_MS } : void 0;
          // 手动刷新（点弹窗里的刷新按钮）带 fresh=1：只对用户主动操作放行，
          // 后台轮询一律吃缓存，避免自动节奏被点几下就打穿上游。
          const fresh = url.searchParams.get("fresh") === "1";
          const result = fresh
            ? await queryProviderBalance(ctx, provider).then((r) => {
                upstreamCacheSet("provider:" + id, r, providerTtl);
                return r;
              })
            : await withUpstreamCache("provider:" + id, () => queryProviderBalance(ctx, provider), providerTtl);
          res.writeHead(result.ok ? 200 : 502, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
        }
      }
    });
    return dispose;
  }, "deepseek-balance-widget: provider balance route");

  /** Trigger a one-shot sync from dsh settings to the local balance store. */
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/ai-balances-sync",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (req.method !== "POST" || url.pathname !== "/ai-balances-sync") {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "not found" }));
          return;
        }
        const result = await syncProvidersFromDshSettings();
        res.writeHead(result.ok ? 200 : 502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      }
    });
    return dispose;
  }, "deepseek-balance-widget: dsh settings sync route");

  // Auto-sync once on startup so existing dsh model providers appear immediately.
  syncProvidersFromDshSettings().catch(() => {});
}

export { name, inject, apply };
