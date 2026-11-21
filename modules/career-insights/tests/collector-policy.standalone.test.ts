import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseGovPolicyDetail,
  parseGovPolicyList,
  parseMoePolicyDetail,
  parseMoePolicyList,
  parseNdrcPolicyDetail,
  parseNdrcPolicyList,
} from "../collector/adapters/policy-parse.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");

async function samplesOf(sourceKey: string): Promise<{ list: string; details: string[] }> {
  const dir = join(SAMPLES, sourceKey, "samples");
  const files = await readdir(dir);
  const list = join(dir, "list.html");
  const details = files
    .filter((name) => /^detail-\d+\.html$/.test(name))
    .sort()
    .map((name) => join(dir, name));
  return { list: await readFile(list, "utf8"), details: await Promise.all(details.map((file) => readFile(file, "utf8"))) };
}

test("国务院政策列表解析出正式政策条目", async () => {
  const { list } = await samplesOf("state-council-policy");
  const items = parseGovPolicyList(list, "https://www.gov.cn/zhengce/index.htm");
  assert.ok(items.length >= 3);
  for (const item of items.slice(0, 3)) {
    assert.ok(item.url.includes("/zhengce/"));
    assert.ok(item.title.length > 5);
    if (item.publishedAt !== null) {
      assert.match(item.publishedAt, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    }
  }
});

test("国务院政策详情解析标题、正文与发布时间，标题回退到 title 标签", async () => {
  const { details } = await samplesOf("state-council-policy");
  assert.equal(details.length, 3);

  const results = details.map((html, index) =>
    parseGovPolicyDetail(html, `https://www.gov.cn/zhengce/content/detail-${index + 1}.htm`),
  );
  for (const detail of results) {
    assert.ok(detail.title.length > 3);
    assert.ok(detail.bodyRaw.length > 100);
    if (detail.publishedAt !== null) {
      assert.match(detail.publishedAt, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    }
  }
  assert.equal(results[1]?.title, "中医药传统知识保护条例");
});

test("发改委政策列表只保留正式通知栏目，日期转换为 UTC", async () => {
  const { list } = await samplesOf("ndrc-policy");
  const items = parseNdrcPolicyList(list, "https://www.ndrc.gov.cn/xxgk/zcfb/tz/");
  assert.ok(items.length >= 3);
  for (const item of items) {
    assert.ok(item.url.includes("/xxgk/zcfb/tz/"));
  }
  assert.ok(items.some((item) => item.publishedAt !== null));
});

test("发改委政策详情解析标题、文号、正文与发布时间", async () => {
  const { details } = await samplesOf("ndrc-policy");
  assert.equal(details.length, 3);

  const results = details.map((html, index) =>
    parseNdrcPolicyDetail(html, `https://www.ndrc.gov.cn/xxgk/zcfb/tz/detail-${index + 1}.html`),
  );
  for (const detail of results) {
    assert.ok(detail.title.includes("通知"));
    assert.ok(detail.bodyRaw.length > 20);
    assert.match(detail.documentNumber ?? "", /〔2026〕\d+号/);
    assert.match(detail.publishedAt ?? "", /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  }
});
test("教育部公告列表解析出正式公告条目", async () => {
  const { list } = await samplesOf("moe-policy");
  const items = parseMoePolicyList(list, "https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/");
  assert.ok(items.length >= 3);
  for (const item of items) {
    assert.ok(item.url.includes("/s5743/s5744/"));
    assert.ok(item.title.length >= 8);
  }
});

test("教育部公告详情解析标题、正文与 meta 发布时间", async () => {
  const { details } = await samplesOf("moe-policy");
  assert.equal(details.length, 3);

  const results = details.map((html, index) =>
    parseMoePolicyDetail(
      html,
      `https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/detail-${index + 1}.html`,
    ),
  );
  for (const detail of results) {
    assert.ok(detail.title.length > 5);
    assert.ok(detail.bodyRaw.length > 20);
    assert.match(detail.publishedAt ?? "", /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    assert.match(detail.url, /^https:\/\/www\.moe\.gov\.cn\//);
  }
});