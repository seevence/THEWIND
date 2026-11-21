import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HttpTransport } from "../collector/fetch/http-transport.ts";
import { createPageRequest } from "../collector/fetch/transport.ts";
import { SchemeDowngradeError } from "../collector/fetch/errors.ts";
import {
  MOE_POLICY_LIST_URL,
  createMoePolicySourceAdapter,
} from "../collector/adapters/policy-sources.ts";
import { parseMoePolicyList } from "../collector/adapters/policy-parse.ts";

// 教育部公告公示栏目只提供 http 正文，https 会 302 到同 host、同 path 的 http 地址。
// 这里验证 fetch 门禁的极窄 allowlist：只有 www.moe.gov.cn + /jyb_xxgk/s5743/s5744/ 才放行降级。

const SAMPLES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../collector/evidence/samples/moe-policy/samples",
);
const MOE_HTTP_LIST_URL = "http://www.moe.gov.cn/jyb_xxgk/s5743/s5744/";

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function htmlPage(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

test("教育部公告公示栏目同 host 同 path 的 HTTPS→HTTP 降级被极窄放行", async () => {
  const fetchImpl = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target === MOE_POLICY_LIST_URL) {
      return redirect(MOE_HTTP_LIST_URL);
    }
    return htmlPage("<html><body>placeholder</body></html>");
  }) as unknown as typeof fetch;
  const transport = new HttpTransport({ fetchImpl });

  const response = await transport.fetchPage(
    createPageRequest({ url: MOE_POLICY_LIST_URL, sourceKey: "moe-policy", pageTimeoutMs: 5_000 }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.finalUrl, MOE_HTTP_LIST_URL);
  assert.equal(response.requestUrl, MOE_POLICY_LIST_URL);
});

test("moe.gov.cn 其他路径的 HTTPS→HTTP 降级仍被拒绝", async () => {
  const fetchImpl = (async () =>
    redirect("http://www.moe.gov.cn/jyb_xxgk/other/index.html")) as unknown as typeof fetch;
  const transport = new HttpTransport({ fetchImpl });
  await assert.rejects(
    transport.fetchPage(
      createPageRequest({
        url: "https://www.moe.gov.cn/jyb_xxgk/other/index.html",
        sourceKey: "moe-policy",
        pageTimeoutMs: 5_000,
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SchemeDowngradeError);
      assert.equal(error.limitationType, "scheme_downgrade");
      return true;
    },
  );
});

test("非 moe.gov.cn 主机的 HTTPS→HTTP 降级仍被拒绝", async () => {
  const fetchImpl = (async () => redirect("http://a.example/start")) as unknown as typeof fetch;
  const transport = new HttpTransport({ fetchImpl });
  await assert.rejects(
    transport.fetchPage(
      createPageRequest({ url: "https://a.example/start", sourceKey: "demo", pageTimeoutMs: 5_000 }),
    ),
    SchemeDowngradeError,
  );
});

test("allowlist 只放行同 path 降级，换 path 或换 host 仍拒绝", async () => {
  const changedPath = (async () =>
    redirect("http://www.moe.gov.cn/jyb_xxgk/s5743/s5744/evil.html")) as unknown as typeof fetch;
  await assert.rejects(
    new HttpTransport({ fetchImpl: changedPath }).fetchPage(
      createPageRequest({ url: MOE_POLICY_LIST_URL, sourceKey: "moe-policy", pageTimeoutMs: 5_000 }),
    ),
    SchemeDowngradeError,
  );

  const changedHost = (async () =>
    redirect("http://www.moe.gov.cn.evil.example/jyb_xxgk/s5743/s5744/")) as unknown as typeof fetch;
  await assert.rejects(
    new HttpTransport({ fetchImpl: changedHost }).fetchPage(
      createPageRequest({ url: MOE_POLICY_LIST_URL, sourceKey: "moe-policy", pageTimeoutMs: 5_000 }),
    ),
    SchemeDowngradeError,
  );
});

test("链式重定向逐跳校验：放行一次降级后，后续换 host 的降级仍被拒绝", async () => {
  const calls: string[] = [];
  const detailHttpsUrl =
    "https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/202610/t20261026_1456016.html";
  const fetchImpl = (async (url: string | URL | Request) => {
    const target = String(url);
    calls.push(target);
    if (target === MOE_POLICY_LIST_URL) {
      return redirect(MOE_HTTP_LIST_URL);
    }
    if (target === MOE_HTTP_LIST_URL) {
      return redirect(detailHttpsUrl);
    }
    return redirect("http://www.moe.gov.cn.evil.example/jyb_xxgk/s5743/s5744/");
  }) as unknown as typeof fetch;
  await assert.rejects(
    new HttpTransport({ fetchImpl }).fetchPage(
      createPageRequest({ url: MOE_POLICY_LIST_URL, sourceKey: "moe-policy", pageTimeoutMs: 5_000 }),
    ),
    SchemeDowngradeError,
  );
  assert.deepEqual(calls, [MOE_POLICY_LIST_URL, MOE_HTTP_LIST_URL, detailHttpsUrl]);
});

test("启用路径端到端：教育部适配器经 HttpTransport 处理 302 后产出 3 条政策", async () => {
  const listHtml = await readFile(join(SAMPLES, "list.html"), "utf8");
  const items = parseMoePolicyList(listHtml, MOE_POLICY_LIST_URL).slice(0, 3);
  assert.equal(items.length, 3);
  const detailByHttpUrl = new Map<string, string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    assert.ok(item);
    detailByHttpUrl.set(item.url.replace("https://", "http://"), await readFile(join(SAMPLES, `detail-${index + 1}.html`), "utf8"));
  }

  const fetchImpl = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target === MOE_POLICY_LIST_URL) {
      return redirect(MOE_HTTP_LIST_URL);
    }
    if (target === MOE_HTTP_LIST_URL) {
      return htmlPage(listHtml);
    }
    if (target.startsWith("https://www.moe.gov.cn/")) {
      return redirect(target.replace("https://", "http://"));
    }
    const detail = detailByHttpUrl.get(target);
    if (detail !== undefined) {
      return htmlPage(detail);
    }
    throw new Error(`未准备的请求：${target}`);
  }) as unknown as typeof fetch;

  const adapter = createMoePolicySourceAdapter(new HttpTransport({ fetchImpl }), {
    itemLimit: 3,
    sleep: async () => undefined,
  });
  const policies = await adapter.collect();
  assert.equal(policies.length, 3);
  for (const policy of policies) {
    assert.equal(policy.issuer, "教育部");
    assert.match(policy.published_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(policy.official_url, /^https:\/\/www\.moe\.gov\.cn\/jyb_xxgk\/s5743\/s5744\//);
    assert.ok(policy.evidence_excerpt.length > 0);
  }
});
