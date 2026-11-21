// Policy list page, standalone: the fixture API answers the policies route, and the rendered list is
// asserted without a database. The page's loader lives beside JSX that Node cannot run directly, so the
// address it builds (policyApiPath), the query parsing and the 400 it answers for bad filters are asserted
// here through the same helpers the loader calls.
import assert from "node:assert/strict";
import { once } from "node:events";
import { after, test } from "node:test";
import * as cheerio from "cheerio";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { FIXTURE_POLICY_LIST_V1 } from "../fixtures/api.ts";
import {
  POLICY_PAGE_SIZE,
  buildPoliciesHref,
  parsePolicyFilters,
  parsePolicyFiltersOrThrow,
  policyApiPath,
  type PolicyListResponse,
  type PolicyPageFilters,
} from "../web/policy.ts";
import { PolicyList } from "../web/components/PolicyList.ts";
import { POLICY_SOURCE_OPTIONS } from "../web/labels.ts";
import { fixtureServer, policyRequests } from "../web/fixture-server.ts";

const FIXTURE_ORIGIN = "http://127.0.0.1:3101";
const FILTERS: PolicyPageFilters = { page: 1, page_size: POLICY_PAGE_SIZE };
const POLICIES = "/career-insights/policies";

if (!fixtureServer.listening) await once(fixtureServer, "listening");
after(() => new Promise<void>((resolve) => {
  fixtureServer.closeAllConnections();
  fixtureServer.close(() => resolve());
}));

function render(policies: PolicyListResponse, filters: PolicyPageFilters): cheerio.CheerioAPI {
  const html = renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: [POLICIES] }, createElement(PolicyList, { policies, filters })),
  );
  return cheerio.load(html);
}

function hrefOf(html: cheerio.CheerioAPI, label: string): URL {
  const link = html("a").filter((_, element) => html(element).text() === label).first();
  assert.ok(link.length > 0, `no link labelled ${label}`);
  return new URL(link.attr("href") ?? "", "http://site.local");
}

/** 与 loader 同款抛法（react-router 的 data()），沿用 job.tsx 的 400 错误页机制。 */
function assertLoaderRejects400(query: string, parameter: string): void {
  const result = parsePolicyFilters(new URLSearchParams(query));
  assert.deepEqual(result, { ok: false, error: { code: "invalid_parameter", parameter } });
  assert.throws(() => parsePolicyFiltersOrThrow(new URLSearchParams(query)), (error: unknown) => {
    const rejection = error as { data?: { error?: { code?: string; parameter?: string } }; init?: { status?: number } };
    return rejection.init?.status === 400
      && rejection.data?.error?.code === "invalid_parameter"
      && rejection.data.error.parameter === parameter;
  }, `${query} should answer 400 instead of being dropped`);
}

test("the list renders every policy with its issuer, date and official link", () => {
  const html = render(FIXTURE_POLICY_LIST_V1, FILTERS);
  const rows = html("[data-policy-item]");
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((_, element) => html(element).text().includes("示例国家部门")).length, 2);

  const links = html("[data-policy-link]");
  assert.equal(links.length, 6);
  links.each((_, element) => {
    const link = html(element);
    assert.match(link.attr("href") ?? "", /^https:\/\/example\.com\/policies\//);
    assert.equal(link.attr("target"), "_blank");
    assert.equal(link.attr("rel"), "noopener noreferrer");
  });

  assert.match(html("[data-policy-item]").first().text(), /2026/);
  assert.match(html("[data-source-tier]").first().text(), /政府官网/);
  assert.match(html("[data-policy-item]").first().text(), /主题：人工智能、人才培养/);
});

test("source and theme filters link to the page with the other filter kept", () => {
  const html = render(FIXTURE_POLICY_LIST_V1, { ...FILTERS, source_key: "ndrc-policy" });
  const source = hrefOf(html, "国家发展改革委政策发布");
  assert.equal(source.pathname, POLICIES);
  assert.equal(source.searchParams.get("source_key"), "ndrc-policy");
  assert.equal(source.searchParams.get("page"), "1");
  assert.equal(source.searchParams.get("page_size"), String(POLICY_PAGE_SIZE));

  const theme = hrefOf(html, "人才培养");
  assert.equal(theme.searchParams.get("theme"), "talent_development");
  assert.equal(theme.searchParams.get("source_key"), "ndrc-policy");
  assert.equal(theme.searchParams.get("page"), "1");
  assert.equal(theme.searchParams.get("page_size"), String(POLICY_PAGE_SIZE));

  const allThemes = html('[data-filter-group="主题"] a').filter((_, element) => html(element).text() === "全部");
  const cleared = new URL(allThemes.first().attr("href") ?? "", "http://site.local");
  assert.equal(cleared.searchParams.get("theme"), null);
  assert.equal(cleared.searchParams.get("source_key"), "ndrc-policy");
});

test("no policies under a valid filter shows the empty state instead of an error", () => {
  const html = render(
    { ...FIXTURE_POLICY_LIST_V1, items: [], total: 0, filters: { ...FILTERS, source_key: "ndrc-policy" } },
    { ...FILTERS, source_key: "ndrc-policy" },
  );
  assert.match(html("body").text(), /当前筛选下暂无政策/);
  assert.equal(hrefOf(html, "清除筛选").pathname, POLICIES);
  assert.equal(hrefOf(html, "清除筛选").searchParams.get("source_key"), null);
});

test("pagination and the API address keep the page size and filters", () => {
  const filters: PolicyPageFilters = {
    page: 2,
    page_size: 50,
    source_key: "ndrc-policy",
    theme: "talent_development",
  };
  const href = new URL(buildPoliciesHref(filters), "http://site.local");
  assert.equal(href.pathname, POLICIES);
  assert.equal(href.searchParams.get("page"), "2");
  assert.equal(href.searchParams.get("page_size"), "50");
  assert.equal(href.searchParams.get("source_key"), "ndrc-policy");
  assert.equal(href.searchParams.get("theme"), "talent_development");

  const parsed = parsePolicyFilters(
    new URLSearchParams("page=2&page_size=50&source_key=ndrc-policy&theme=talent_development"),
  );
  assert.deepEqual(parsed, { ok: true, filters });
  assert.equal(
    policyApiPath(parsed.ok ? parsed.filters : filters),
    "/policies?source_key=ndrc-policy&theme=talent_development&page=2&page_size=50",
  );
});

test("valid filters are kept and absent filters stay absent", () => {
  assert.deepEqual(parsePolicyFilters(new URLSearchParams("")), {
    ok: true,
    filters: { page: 1, page_size: POLICY_PAGE_SIZE },
  });
  assert.deepEqual(parsePolicyFilters(new URLSearchParams("source_key=ndrc-policy&theme=talent_development")), {
    ok: true,
    filters: { source_key: "ndrc-policy", theme: "talent_development", page: 1, page_size: POLICY_PAGE_SIZE },
  });
});

test("unknown, malformed and prototype-chain filters answer 400 instead of being dropped", () => {
  assertLoaderRejects400("source_key=__bad__", "source_key");
  assertLoaderRejects400("source_key=UPPER", "source_key");
  // 来源选项改由 facets 驱动：形态合法的新源不应被 400 拒绝。
  assert.deepEqual(parsePolicyFilters(new URLSearchParams("source_key=moe-policy")), {
    ok: true,
    filters: { source_key: "moe-policy", page: 1, page_size: POLICY_PAGE_SIZE },
  });
  assertLoaderRejects400("theme=__bad__", "theme");
  assertLoaderRejects400("theme=constructor", "theme");
  assertLoaderRejects400("theme=__proto__", "theme");
  assertLoaderRejects400("theme=toString", "theme");
  assertLoaderRejects400("page=0", "page");
  assertLoaderRejects400("page=abc", "page");
  assertLoaderRejects400("page=10001", "page");
  assertLoaderRejects400("page_size=0", "page_size");
  assertLoaderRejects400("page_size=abc", "page_size");
  assertLoaderRejects400("page_size=101", "page_size");
});

test("the fixture API serves the unfiltered list and narrows it by source_key", async () => {
  const all = await fetch(`${FIXTURE_ORIGIN}/api/site/career-insights/policies`);
  assert.equal(all.status, 200);
  const allBody = (await all.json()) as PolicyListResponse;
  assert.equal(allBody.items.length, 6);

  const ndrc = await fetch(`${FIXTURE_ORIGIN}/api/site/career-insights/policies?source_key=ndrc-policy`);
  assert.equal(ndrc.status, 200);
  const ndrcBody = (await ndrc.json()) as PolicyListResponse;
  assert.equal(ndrcBody.items.length, 3);
  assert.equal(ndrcBody.total, 3);
  assert.deepEqual(ndrcBody.filters, { page: 1, page_size: 20, source_key: "ndrc-policy" });
});

test("the fixture API rejects parameters the backend rejects", async () => {
  const paged = await fetch(`${FIXTURE_ORIGIN}/api/site/career-insights/policies?page=2&page_size=20&source_key=ndrc-policy&theme=talent_development`);
  assert.equal(paged.status, 200);
  const body = (await paged.json()) as PolicyListResponse;
  assert.equal(body.items.length, 3);
  assert.equal(body.page, 2);
  assert.equal(body.page_size, 20);
  assert.deepEqual(body.filters, { page: 2, page_size: 20, source_key: "ndrc-policy", theme: "talent_development" });
  assert.deepEqual(policyRequests.at(-1)?.get("page"), "2");

  const badPage = await fetch(`${FIXTURE_ORIGIN}/api/site/career-insights/policies?page=99999`);
  assert.equal(badPage.status, 400);
  const badSource = await fetch(`${FIXTURE_ORIGIN}/api/site/career-insights/policies?source_key=unknown-source`);
  assert.equal(badSource.status, 400);
  const badTheme = await fetch(`${FIXTURE_ORIGIN}/api/site/career-insights/policies?theme=constructor`);
  assert.equal(badTheme.status, 400);
});
const FACETS = {
  sources: [
    { source_key: "state-council-policy", count: 3 },
    { source_key: "ndrc-policy", count: 3 },
    { source_key: "moe-policy", count: 2 },
  ],
  themes: [
    { theme_id: "talent_development", count: 1 },
    { theme_id: "employment_promotion", count: 1 },
  ],
};

test("source chips come from facets with counts and keep page_size", () => {
  const html = render({ ...FIXTURE_POLICY_LIST_V1, facets: FACETS }, { ...FILTERS, page_size: 50 });
  const ndrc = hrefOf(html, "国家发展改革委政策发布（3）");
  assert.equal(ndrc.searchParams.get("source_key"), "ndrc-policy");
  assert.equal(ndrc.searchParams.get("page_size"), "50");

  // facets 中的新源不在静态清单里，也应渲染为 chip（label 回退 key）。
  const moe = hrefOf(html, "moe-policy（2）");
  assert.equal(moe.searchParams.get("source_key"), "moe-policy");
  assert.equal(moe.searchParams.get("page_size"), "50");
});

test("chips keep full facet counts after filtering by one source", () => {
  const html = render(
    { ...FIXTURE_POLICY_LIST_V1, facets: FACETS },
    { ...FILTERS, source_key: "ndrc-policy", page_size: 50 },
  );
  const active = html("a").filter((_, element) => html(element).text() === "国家发展改革委政策发布（3）").first();
  assert.equal(active.attr("aria-current"), "page");
  assert.equal(hrefOf(html, "中国政府网政策文件库（3）").searchParams.get("page_size"), "50");
  assert.equal(hrefOf(html, "moe-policy（2）").searchParams.get("source_key"), "moe-policy");
});

test("missing facets fall back to the static source list", () => {
  const html = render(FIXTURE_POLICY_LIST_V1, FILTERS);
  assert.equal(html('[data-filter-group="来源"] a').length, POLICY_SOURCE_OPTIONS.length + 1);
  assert.match(html('[data-filter-group="来源"]').text(), /中国政府网政策文件库/);
  assert.match(html('[data-filter-group="来源"]').text(), /国家发展改革委政策发布/);
  assert.equal(html('[data-filter-empty="source"]').length, 0);
});

test("empty facets show no filter options instead of stale chips", () => {
  const html = render({ ...FIXTURE_POLICY_LIST_V1, facets: { sources: [], themes: [] } }, FILTERS);
  assert.match(html('[data-filter-empty="source"]').text(), /暂无来源筛选选项/);
  assert.match(html('[data-filter-empty="theme"]').text(), /暂无主题筛选选项/);
  assert.equal(html('[data-filter-group="来源"]').length, 0);
});
test("theme chips come from facets and drop options without policies", () => {
  const html = render({ ...FIXTURE_POLICY_LIST_V1, facets: FACETS }, FILTERS);
  const themes = html('[data-filter-group="主题"]').text();
  assert.match(themes, /人才培养（1）/);
  assert.match(themes, /就业促进（1）/);
  assert.doesNotMatch(themes, /数字经济/);
});