import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const FIELDS = {
  id: "券ID",
  platform: "平台标识",
  platformName: "平台名称",
  tab: "tab",
  title: "标题",
  subtitle: "副标题",
  primaryURL: "主推广链接",
  fallbackURL: "备用链接",
  enabled: "启用",
  sort: "排序",
  startsAt: "开始时间",
  endsAt: "结束时间"
};

function defaultTab(platform, platformName) {
  return {
    jd: "京东",
    jd_food: "京东外卖",
    express: "快递优惠",
    didi: "滴滴",
    taobao: "淘宝",
    meituan: "美团",
    pdd: "拼多多",
    movie: "电影票",
    travel: "游玩度假",
    restaurant: "连锁餐饮"
  }[platform] || platformName;
}

const DEFAULT_ALLOWED_HOSTS = [
  "jd.com",
  "meituan.com",
  "dianping.com",
  "dpurl.cn",
  "taobao.com",
  "tb.cn",
  "alimama.com",
  "ele.me",
  "pinduoduo.com",
  "yangkeduo.com",
  "didi.cn",
  "didiglobal.com",
  "kurl07.cn",
  "kurl04.cn",
  "kurl05.cn",
  "kurl06.cn",
  "kurl08.cn",
  "kzurl18.cn",
  "yinghuasuan.com",
  "youpiaopiao.cn",
  "feizhu.com",
  "jutuike.cn",
  "qipiao.net",
  "jfshou.cn",
  "dtsoft.cn"
];

const EXPIRY_PATTERNS = [
  "活动已结束",
  "活动结束",
  "活动已下线",
  "链接已失效",
  "页面不存在",
  "优惠已结束"
];

export function textValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("");
  if (typeof value === "object") {
    return textValue(value.link || value.url || value.text || value.name || value.value);
  }
  return "";
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "是", "启用"].includes(textValue(value).toLowerCase());
}

function numberValue(value, fallback = 0) {
  const number = Number(textValue(value));
  return Number.isFinite(number) ? number : fallback;
}

function timestampValue(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value;
  const numeric = Number(textValue(value));
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(textValue(value));
  return Number.isNaN(parsed) ? null : parsed;
}

export function recordToCoupon(record) {
  const fields = record.fields || {};
  const platform = textValue(fields[FIELDS.platform]);
  const platformName = textValue(fields[FIELDS.platformName]);
  return {
    id: textValue(fields[FIELDS.id]),
    platform,
    platformName,
    tab: textValue(fields[FIELDS.tab]) || defaultTab(platform, platformName),
    title: textValue(fields[FIELDS.title]),
    subtitle: textValue(fields[FIELDS.subtitle]),
    tag: "",
    iconText: platformName.slice(0, 1),
    primaryURL: textValue(fields[FIELDS.primaryURL]),
    fallbackURL: textValue(fields[FIELDS.fallbackURL]),
    enabled: booleanValue(fields[FIELDS.enabled]),
    sort: numberValue(fields[FIELDS.sort]),
    startsAt: timestampValue(fields[FIELDS.startsAt]),
    endsAt: timestampValue(fields[FIELDS.endsAt])
  };
}

export function isHostAllowed(rawURL, allowedHosts) {
  try {
    const url = new URL(rawURL);
    if (!["https:", "http:"].includes(url.protocol)) return false;
    const hostname = url.hostname.toLowerCase();
    return allowedHosts.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`)
    );
  } catch {
    return false;
  }
}

export async function probeURL(rawURL, allowedHosts, fetchImpl = fetch) {
  if (!isHostAllowed(rawURL, allowedHosts)) {
    return { ok: false, reason: "目标域名不在白名单" };
  }

  try {
    const response = await fetchImpl(rawURL, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "ShengShengHuaHua-LinkChecker/1.0",
        Range: "bytes=0-65535"
      },
      signal: AbortSignal.timeout(10000)
    });
    const finalURL = response.url || rawURL;
    if (!isHostAllowed(finalURL, allowedHosts)) {
      return { ok: false, reason: "最终跳转域名不在白名单" };
    }
    if (!response.ok && response.status !== 206) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    const body = (await response.text()).slice(0, 65536);
    const matched = EXPIRY_PATTERNS.find((pattern) => body.includes(pattern));
    return matched
      ? { ok: false, reason: `页面包含“${matched}”` }
      : { ok: true, reason: "访问正常", finalURL };
  } catch (error) {
    return {
      ok: false,
      reason: error.name === "TimeoutError" ? "访问超时" : error.message
    };
  }
}

async function tenantToken(config, fetchImpl) {
  const response = await fetchImpl(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: config.appID, app_secret: config.appSecret })
    }
  );
  const payload = await response.json();
  if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(`飞书认证失败：${payload.msg || response.status}`);
  }
  return payload.tenant_access_token;
}

async function listRecords(config, fetchImpl = fetch) {
  const token = await tenantToken(config, fetchImpl);
  const records = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ page_size: "500" });
    if (pageToken) query.set("page_token", pageToken);
    const url =
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}` +
      `/tables/${config.tableID}/records?${query}`;
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      }
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(`读取飞书失败：${payload.msg || response.status}`);
    }
    records.push(...(payload.data?.items || []));
    pageToken = payload.data?.has_more ? payload.data.page_token : "";
  } while (pageToken);
  return records;
}

function isActive(coupon, now) {
  if (!coupon.enabled || !coupon.id || !coupon.title) return false;
  if (coupon.startsAt && coupon.startsAt > now) return false;
  return !(coupon.endsAt && coupon.endsAt <= now);
}

export async function buildPublicCoupons(
  records,
  { allowedHosts = DEFAULT_ALLOWED_HOSTS, now = Date.now(), probe = probeURL } = {}
) {
  const output = [];
  const checks = [];

  for (const record of records) {
    const coupon = recordToCoupon(record);
    if (!isActive(coupon, now)) continue;

    const primary = await probe(coupon.primaryURL, allowedHosts);
    let fallback = null;
    if (!primary.ok && coupon.fallbackURL) {
      fallback = await probe(coupon.fallbackURL, allowedHosts);
    }
    const targetURL = primary.ok
      ? coupon.primaryURL
      : fallback?.ok
        ? coupon.fallbackURL
        : null;

    checks.push({
      id: coupon.id,
      ok: Boolean(targetURL),
      source: primary.ok ? "primary" : fallback?.ok ? "fallback" : "none",
      reason: primary.ok ? primary.reason : fallback?.ok ? primary.reason : fallback?.reason || primary.reason
    });
    if (!targetURL) continue;

    output.push({
      id: coupon.id,
      platform: coupon.platform,
      platform_name: coupon.platformName,
      tab: coupon.tab,
      title: coupon.title,
      subtitle: coupon.subtitle,
      tag: coupon.tag,
      icon_text: coupon.iconText || coupon.platformName.slice(0, 1),
      coupon_url: targetURL,
      fallback_url: null,
      sort: coupon.sort,
      enabled: true
    });
  }

  output.sort((left, right) => left.sort - right.sort || left.title.localeCompare(right.title, "zh-CN"));
  return { coupons: output, checks };
}

export function loadConfig(env = process.env) {
  const required = [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_BITABLE_APP_TOKEN",
    "FEISHU_BITABLE_TABLE_ID"
  ];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) throw new Error(`缺少配置：${missing.join(", ")}`);
  return {
    appID: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appToken: env.FEISHU_BITABLE_APP_TOKEN,
    tableID: env.FEISHU_BITABLE_TABLE_ID,
    allowedHosts: (env.ALLOWED_TARGET_HOSTS || DEFAULT_ALLOWED_HOSTS.join(","))
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  };
}

async function main() {
  const config = loadConfig();
  const records = await listRecords(config);
  const result = await buildPublicCoupons(records, { allowedHosts: config.allowedHosts });
  if (!result.coupons.length) {
    throw new Error("没有可发布的优惠券，保留上一次配置");
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "coupons.json"), `${JSON.stringify(result.coupons, null, 2)}\n`);
  await writeFile(
    path.join(docs, "status.json"),
    `${JSON.stringify({ generated_at: new Date().toISOString(), checks: result.checks }, null, 2)}\n`
  );
  process.stdout.write(`已发布 ${result.coupons.length} 个优惠入口\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
