import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPublicCoupons,
  isHostAllowed,
  recordToCoupon,
  textValue
} from "../scripts/sync.mjs";

function record(overrides = {}) {
  return {
    fields: {
      券ID: "meal",
      平台标识: "meituan",
      平台名称: "美团",
      tab: "美团",
      标题: "每日红包",
      副标题: "下单前先领券",
      主推广链接: { link: "https://union.meituan.com/a" },
      备用链接: "https://dpurl.cn/b",
      启用: true,
      排序: 10,
      ...overrides
    }
  };
}

test("读取飞书富文本和链接字段", () => {
  assert.equal(textValue([{ text: "省省" }, { text: "花花" }]), "省省花花");
  const coupon = recordToCoupon(record());
  assert.equal(coupon.primaryURL, "https://union.meituan.com/a");
  assert.equal(coupon.tab, "美团");
});

test("只允许白名单域名及其子域名", () => {
  assert.equal(isHostAllowed("https://union.meituan.com/a", ["meituan.com"]), true);
  assert.equal(isHostAllowed("https://p.pinduoduo.com/a", ["pinduoduo.com"]), true);
  assert.equal(isHostAllowed("javascript:alert(1)", ["meituan.com"]), false);
  assert.equal(isHostAllowed("https://meituan.com.example.com", ["meituan.com"]), false);
});

test("主链接失败时使用备用链接", async () => {
  const probe = async (url) =>
    url.includes("dpurl.cn") ? { ok: true, reason: "正常" } : { ok: false, reason: "失效" };
  const result = await buildPublicCoupons([record()], { probe });
  assert.equal(result.coupons[0].coupon_url, "https://dpurl.cn/b");
  assert.equal(result.coupons[0].tab, "美团");
  assert.equal(result.checks[0].source, "fallback");
});

test("主备链接都失败时不发布该入口", async () => {
  const result = await buildPublicCoupons([record()], {
    probe: async () => ({ ok: false, reason: "失效" })
  });
  assert.deepEqual(result.coupons, []);
});

test("忽略停用及过期入口并按排序输出", async () => {
  const probe = async () => ({ ok: true, reason: "正常" });
  const disabled = record({ 券ID: "disabled", 启用: false });
  const expired = record({ 券ID: "expired", 结束时间: Date.now() - 1000 });
  const later = record({ 券ID: "later", 标题: "晚", 排序: 20 });
  const earlier = record({ 券ID: "earlier", 标题: "早", 排序: 5 });
  const result = await buildPublicCoupons([disabled, expired, later, earlier], { probe });
  assert.deepEqual(result.coupons.map((coupon) => coupon.id), ["earlier", "later"]);
});
