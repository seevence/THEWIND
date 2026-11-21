/// <reference lib="dom" />
// 岗位与 career 页面的搜索元数据，standalone：页面是 JSX（Node 不能直接跑），meta、结构化数据与 RSS 发现
// 链接的构造放在 web/seo.ts，这里断言页面 meta 实际返回的那组标签。要点：标题接站名、描述只用库里的真实
// 字段、canonical 带岗位 id；JobPosting 字段正确且不写 validThrough；ItemList 只列前 20 条真实入口；
// BreadcrumbList 是 首页 → 职业洞察 → …；head 里的 RSS 链接与后端注册的 feed 路径一致；联调样例（虚构
// 数据）不索引也不输出结构化数据。
// sitemap 条目（backend/sitemap.ts）在这里用注入的假行断言：三个索引页、每个存在的岗位、上限 5000。
import assert from "node:assert/strict";
import { test } from "node:test";
import { siteUrl } from "@aihot/web/lib/seo";
import { SITE } from "@aihot/site";
import type { JobDetailResponseV1, JobListResponseV1 } from "../contracts/api.ts";
import type { PolicyListResponseV1 } from "../backend/policy-read.ts";
import { FIXTURE_DAILY_V1, FIXTURE_JOB_DETAIL_V1, FIXTURE_JOB_LIST_V1, FIXTURE_POLICY_LIST_V1 } from "../fixtures/api.ts";
import { SITEMAP_JOB_LIMIT, careerSitemapEntries } from "../backend/sitemap.ts";
import { CAREER_FEED_PATHS } from "../backend/routes/feeds.ts";

/** 联调样例的政策列表（fixture 没带 facets，这里补齐成契约形状）。 */
const SYNTHETIC_POLICIES: PolicyListResponseV1 = { ...FIXTURE_POLICY_LIST_V1, facets: { sources: [], themes: [] } };
import {
  DAILY_PATH,
  DASHBOARD_PATH,
  JOBS_PATH,
  POLICIES_PATH,
  STRUCTURED_LIST_LIMIT,
  careerDailyMeta,
  careerDashboardMeta,
  careerFeedLink,
  careerJobsMeta,
  careerPoliciesMeta,
  jobDescription,
  jobDetailPath,
  jobMeta,
  jobPostingDescription,
  jobPostingLd,
} from "../web/seo.ts";

type Tag = Record<string, unknown>;
const tagsOf = (meta: unknown): Tag[] => meta as Tag[];

function titleOf(tags: Tag[]): string {
  const tag = tags.find((candidate) => typeof candidate.title === "string");
  assert.ok(tag, "no <title> tag");
  return tag.title as string;
}

function descriptionOf(tags: Tag[]): string {
  const tag = tags.find((candidate) => candidate.name === "description");
  assert.ok(tag, "no meta description");
  return tag.content as string;
}

function canonicalOf(tags: Tag[]): string {
  const tag = tags.find((candidate) => candidate.tagName === "link" && candidate.rel === "canonical");
  assert.ok(tag, "no canonical link");
  return tag.href as string;
}

function robotsOf(tags: Tag[]): string | undefined {
  return tags.find((candidate) => candidate.name === "robots")?.content as string | undefined;
}

/** 页面唯一的 JSON-LD script 的内容：可能是单个对象，也可能是 pageMeta 收下的对象数组。 */
function ldValueOf(tags: Tag[]): unknown {
  const tag = tags.find((candidate) => candidate["script:ld+json"] !== undefined);
  return tag === undefined ? null : tag["script:ld+json"];
}

function ldBlocks(tags: Tag[]): Array<Record<string, unknown>> {
  const value = ldValueOf(tags);
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as Array<Record<string, unknown>>;
}

function ldOfType(tags: Tag[], type: string): Record<string, unknown> | null {
  return ldBlocks(tags).find((block) => block["@type"] === type) ?? null;
}

type ListEntry = { "@type": string; position: number; name: string; url: string };
const listEntries = (list: Record<string, unknown>): ListEntry[] => list.itemListElement as ListEntry[];

type CrumbEntry = { "@type": string; position: number; name: string; item: string };
function crumbsOf(tags: Tag[]): CrumbEntry[] {
  const crumb = ldOfType(tags, "BreadcrumbList");
  assert.ok(crumb, "no BreadcrumbList");
  return crumb.itemListElement as CrumbEntry[];
}

/** 发现链接（RSS）与引擎报告页同一形状：rel=alternate、type=application/rss+xml、相对站内路径。 */
function feedLinkOf(tags: Tag[]): Tag | null {
  return tags.find((candidate) => candidate.tagName === "link" && candidate.rel === "alternate" && candidate.type === "application/rss+xml") ?? null;
}

/** 可索引的真实岗位（fixture 的形状，但 data_origin 是 live）。 */
const LIVE: JobDetailResponseV1 = { ...FIXTURE_JOB_DETAIL_V1, data_origin: "live" };

const LIVE_JOBS = (count: number): JobListResponseV1 => ({
  ...FIXTURE_JOB_LIST_V1,
  data_origin: "live",
  total: count,
  items: Array.from({ length: count }, (_, index) => ({
    ...FIXTURE_JOB_LIST_V1.items[0]!,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    title: `岗位 ${index + 1}`,
  })),
});

const LIVE_POLICIES = (count: number): PolicyListResponseV1 => {
  const bases = FIXTURE_POLICY_LIST_V1.items;
  return {
    ...FIXTURE_POLICY_LIST_V1,
    data_origin: "live",
    facets: { sources: [], themes: [] },
    total: count,
    items: Array.from({ length: count }, (_, index) => ({
      ...bases[index % bases.length]!,
      policy_item_id: `live-policy-${index + 1}`,
      title: `政策 ${index + 1}`,
      official_url: `https://example.com/policies/live-${index + 1}`,
    })),
  };
};

test("职位详情 meta：标题是职位名接站名，描述只用库里的真实字段，canonical 带 id", () => {
  const tags = tagsOf(jobMeta(LIVE));
  assert.equal(titleOf(tags), `${LIVE.job.title} · ${SITE.name}`);
  assert.equal(new URL(canonicalOf(tags)).pathname, `/career-insights/jobs/${LIVE.job.id}`);
  assert.equal(jobDetailPath(LIVE.job.id), `/career-insights/jobs/${LIVE.job.id}`);

  const description = descriptionOf(tags);
  assert.match(description, /虚构样例科技有限公司/, "company");
  assert.match(description, /虚构市/, "city");
  assert.match(description, /软件 \/ AI 应用开发/, "role family label, not the enum");
  assert.match(description, /实习/, "employment type label");
  assert.match(description, /学生友好：是/);
  assert.match(description, /Python/, "skills by their labels");
  assert.equal(jobDescription(LIVE.job), description);

  assert.equal(robotsOf(tags), "max-image-preview:large", "a real job is indexable");
  assert.equal(tags.some((tag) => tag.name === "googlebot"), false);
});

test("JobPosting 结构化数据：标题、datePosted、公司、CN 城市、纯文本描述与 directApply", () => {
  const tags = tagsOf(jobMeta(LIVE));
  const ld = ldOfType(tags, "JobPosting");
  assert.ok(ld, "live jobs carry JobPosting");
  assert.equal(ld["@context"], "https://schema.org");
  assert.equal(ld.title, LIVE.job.title);
  assert.equal(ld.datePosted, LIVE.job.first_seen_at, "datePosted is the first observation, as the page shows it");
  assert.deepEqual(ld.hiringOrganization, { "@type": "Organization", name: LIVE.job.company_name });
  assert.deepEqual(ld.jobLocation, {
    "@type": "Place",
    address: { "@type": "PostalAddress", addressCountry: "CN", addressLocality: "虚构市" },
  });
  assert.equal(ld.employmentType, "INTERN");
  assert.equal(ld.directApply, false, "readers apply on the official page");
  assert.equal("validThrough" in ld, false, "no invented expiry: availability is the latest observation");
  assert.equal(new URL(String(ld["@id"])).pathname, `/career-insights/jobs/${LIVE.job.id}`);

  const description = String(ld.description);
  assert.match(description, /招聘岗位：/, "the structured facts head it");
  assert.match(description, /虚构观测摘录/, "the observation excerpt the page also shows");
  assert.doesNotMatch(description, /<[^>]+>/, "plain text, no HTML tags");
  assert.ok(description.length <= 800);
});

test("JobPosting 描述去 HTML、多个城市给数组、没有城市时只给国家", () => {
  const html: JobDetailResponseV1 = {
    ...LIVE,
    observations: [{ ...LIVE.observations[0]!, evidence_excerpt: "<p>负责&nbsp;模型<br/>训练</p>" }],
  };
  const description = jobPostingDescription(html);
  assert.doesNotMatch(description, /<|>|&nbsp/);
  assert.match(description, /负责 模型 训练/);

  const multi = jobPostingLd({ ...LIVE, job: { ...LIVE.job, locations: ["北京", "上海"] } });
  const places = multi?.jobLocation as Array<{ address: { addressCountry: string; addressLocality: string } }>;
  assert.equal(places.length, 2);
  assert.deepEqual(places.map((place) => place.address.addressLocality), ["北京", "上海"]);
  places.forEach((place) => assert.equal(place.address.addressCountry, "CN"));

  const noCity = jobPostingLd({ ...LIVE, job: { ...LIVE.job, locations: [] } });
  const only = noCity?.jobLocation as { address: Record<string, string> };
  assert.equal(only.address.addressCountry, "CN");
  assert.equal("addressLocality" in only.address, false);
});

test("职位详情 BreadcrumbList：首页 → 职业洞察 → 热门岗位 → 职位名", () => {
  const crumbs = crumbsOf(tagsOf(jobMeta(LIVE)));
  assert.deepEqual(crumbs.map((crumb) => crumb.name), ["首页", "职业洞察", "热门岗位", LIVE.job.title]);
  assert.deepEqual(crumbs.map((crumb) => crumb.position), [1, 2, 3, 4]);
  assert.deepEqual(crumbs.map((crumb) => new URL(crumb.item).pathname), [
    "/",
    DASHBOARD_PATH,
    JOBS_PATH,
    jobDetailPath(LIVE.job.id),
  ]);
});

test("联调样例（synthetic_fixture）不输出 JobPosting/面包屑，也不让搜索引擎索引", () => {
  assert.equal(jobPostingLd(FIXTURE_JOB_DETAIL_V1), null);
  const tags = tagsOf(jobMeta(FIXTURE_JOB_DETAIL_V1));
  assert.equal(ldValueOf(tags), null, "虚拟职位连面包屑都不列");
  assert.equal(robotsOf(tags), "noindex, follow");
});

test("岗位列表 meta：关键词视图不索引、不输出 ItemList，canonical 是列表页，head 带岗位 RSS", () => {
  const tags = tagsOf(careerJobsMeta({ keyword: "算法", jobs: LIVE_JOBS(25) }));
  assert.equal(titleOf(tags), `岗位搜索：算法 · ${SITE.name}`);
  assert.equal(new URL(canonicalOf(tags)).pathname, JOBS_PATH);
  assert.match(descriptionOf(tags), /「算法」相关岗位/);
  // 搜索结果是同一列表页的视图：noindex，且不把按关键词变化的内容写进 ItemList。
  assert.equal(robotsOf(tags), "noindex, follow");
  assert.equal(ldOfType(tags, "ItemList"), null);
  assert.deepEqual(crumbsOf(tags).map((crumb) => crumb.name), ["首页", "职业洞察", "热门岗位"]);
  assert.deepEqual(feedLinkOf(tags), {
    tagName: "link",
    rel: "alternate",
    type: "application/rss+xml",
    title: `${SITE.name} 就业岗位`,
    href: "/feed/jobs.xml",
  });
});

test("干净的岗位列表可索引：ItemList 前 20 个岗位带 position/name/url", () => {
  const tags = tagsOf(careerJobsMeta({ jobs: LIVE_JOBS(25) }));
  assert.equal(titleOf(tags), `热门岗位 · ${SITE.name}`);
  assert.equal(robotsOf(tags), "max-image-preview:large");

  const list = ldOfType(tags, "ItemList");
  assert.ok(list, "a live job list carries ItemList");
  assert.equal(list["@type"], "ItemList");
  assert.equal(list.numberOfItems, STRUCTURED_LIST_LIMIT);
  assert.equal(new URL(String(list.url)).pathname, JOBS_PATH);
  const entries = listEntries(list);
  assert.equal(entries.length, 20);
  assert.deepEqual(entries[0], {
    "@type": "ListItem",
    position: 1,
    name: "岗位 1",
    url: `${siteUrl()}${jobDetailPath("00000000-0000-4000-8000-000000000001")}`,
  });
  assert.equal(entries[19]!.position, 20);
  assert.ok(entries.every((entry) => new URL(entry.url).pathname.startsWith("/career-insights/jobs/")), "every entry links to a job detail page");
  assert.deepEqual(crumbsOf(tags).map((crumb) => crumb.name), ["首页", "职业洞察", "热门岗位"]);
});

test("岗位列表没有真实岗位时不输出 ItemList，但面包屑与 RSS 仍在", () => {
  const tags = tagsOf(careerJobsMeta({ jobs: LIVE_JOBS(0) }));
  assert.equal(ldOfType(tags, "ItemList"), null);
  assert.equal(crumbsOf(tags).length, 3);
  assert.ok(feedLinkOf(tags));

  const synthetic = tagsOf(careerJobsMeta({ jobs: FIXTURE_JOB_LIST_V1 }));
  assert.equal(ldOfType(synthetic, "ItemList"), null, "虚构职位不进结构化数据");
});

test("政策页 meta：ItemList 前 20 条政策用标题与政府原文地址，head 带政策 RSS", () => {
  const policies = LIVE_POLICIES(25);
  const tags = tagsOf(careerPoliciesMeta(policies));
  assert.equal(new URL(canonicalOf(tags)).pathname, POLICIES_PATH);
  assert.equal(robotsOf(tags), "max-image-preview:large");

  const list = ldOfType(tags, "ItemList");
  assert.ok(list, "a live policy list carries ItemList");
  assert.equal(list.numberOfItems, 20);
  assert.equal(new URL(String(list.url)).pathname, POLICIES_PATH);
  const entries = listEntries(list);
  assert.equal(entries.length, 20);
  assert.deepEqual(entries[0], {
    "@type": "ListItem",
    position: 1,
    name: "政策 1",
    url: "https://example.com/policies/live-1",
  });
  assert.equal(entries[19]!.name, "政策 20");

  assert.deepEqual(crumbsOf(tags).map((crumb) => crumb.name), ["首页", "职业洞察", "政策文件"]);
  assert.deepEqual(feedLinkOf(tags), {
    tagName: "link",
    rel: "alternate",
    type: "application/rss+xml",
    title: `${SITE.name} 就业政策`,
    href: "/feed/policies.xml",
  });
});

test("职业洞察页 meta：标题/描述/canonical + 面包屑 + 岗位 RSS 链接", () => {
  const tags = tagsOf(careerDashboardMeta());
  assert.equal(titleOf(tags), `职业洞察：岗位职族、技能需求与政策动向 · ${SITE.name}`);
  assert.ok(descriptionOf(tags).length > 0);
  assert.equal(new URL(canonicalOf(tags)).pathname, DASHBOARD_PATH);
  assert.equal(robotsOf(tags), "max-image-preview:large");
  assert.deepEqual(crumbsOf(tags).map((crumb) => crumb.name), ["首页", "职业洞察"]);
  assert.deepEqual(feedLinkOf(tags)?.href, CAREER_FEED_PATHS.jobs);
});

test("联调样例不索引职业洞察与政策页，也不输出政策 ItemList", () => {
  const dashboard = tagsOf(careerDashboardMeta("synthetic_fixture"));
  assert.equal(robotsOf(dashboard), "noindex, follow");
  const policies = tagsOf(careerPoliciesMeta(SYNTHETIC_POLICIES));
  assert.equal(robotsOf(policies), "noindex, follow");
  assert.equal(ldOfType(policies, "ItemList"), null, "虚构政策不进结构化数据");
});

test("就业日报 meta：标题带日报日期、canonical 与分享图不变、head 带就业日报 RSS", () => {
  const tags = tagsOf(careerDailyMeta(FIXTURE_DAILY_V1));
  assert.equal(titleOf(tags), `就业日报（${FIXTURE_DAILY_V1.date}） · ${SITE.name}`);
  assert.equal(new URL(canonicalOf(tags)).pathname, DAILY_PATH);
  assert.match(String(tags.find((tag) => tag.property === "og:image")?.content), /\/og\/pages\/daily\.png$/);
  assert.deepEqual(feedLinkOf(tags), {
    tagName: "link",
    rel: "alternate",
    type: "application/rss+xml",
    title: `${SITE.name} 就业日报`,
    href: "/feed/career-daily.xml",
  });

  const noData = tagsOf(careerDailyMeta());
  assert.equal(titleOf(noData), `就业日报 · ${SITE.name}`);
  assert.deepEqual(feedLinkOf(noData)?.href, CAREER_FEED_PATHS.daily, "no cache still advertises the feed");
});

test("页面 head 的 RSS 链接与后端注册的 feed 路径一致", () => {
  const feedHref = (kind: "jobs" | "policies" | "daily") => (careerFeedLink(kind) as { href?: string }).href;
  assert.equal(feedHref("jobs"), CAREER_FEED_PATHS.jobs);
  assert.equal(feedHref("policies"), CAREER_FEED_PATHS.policies);
  assert.equal(feedHref("daily"), CAREER_FEED_PATHS.daily);
  assert.deepEqual(Object.keys(CAREER_FEED_PATHS).sort(), ["daily", "jobs", "policies"]);
});

test("sitemap 条目：三个索引页加每个存在的岗位详情，lastmod 是最近观测时间", async () => {
  const latest = new Date("2026-11-20T01:02:03.000Z");
  const entries = await careerSitemapEntries(async () => [
    { id: "16a8e9cb-d603-4c93-a5c6-5ee2f3757dd4", last_seen_at: latest },
    { id: "80607adb-4766-45f9-baa5-5ac9b31b5e7d", last_seen_at: "2026-11-19T00:00:00.000Z" },
  ]);
  assert.deepEqual(entries.map((entry) => entry.loc), [
    "/career-insights",
    "/career-insights/jobs",
    "/career-insights/policies",
    "/career-insights/jobs/16a8e9cb-d603-4c93-a5c6-5ee2f3757dd4",
    "/career-insights/jobs/80607adb-4766-45f9-baa5-5ac9b31b5e7d",
  ]);
  assert.equal(entries[3]!.lastmod?.toISOString(), latest.toISOString());
  assert.equal(entries[4]!.lastmod?.toISOString(), "2026-11-19T00:00:00.000Z");
  const missing = "00000000-0000-4000-8000-000000000000";
  assert.ok(!entries.some((entry) => entry.loc.includes(missing)), "a job that does not exist is never listed");
});

test("sitemap 里不存在岗位：没有岗位时只剩三个索引页", async () => {
  const entries = await careerSitemapEntries(async () => []);
  assert.deepEqual(entries.map((entry) => entry.loc), ["/career-insights", "/career-insights/jobs", "/career-insights/policies"]);
  assert.ok(entries.every((entry) => entry.lastmod === undefined));
});

test("sitemap 岗位 URL 上限 5000，注入更多行也不撑大 sitemap", async () => {
  const rows = Array.from({ length: SITEMAP_JOB_LIMIT + 5 }, (_, index) => ({
    id: `job-${index}`,
    last_seen_at: new Date("2026-11-20T00:00:00.000Z"),
  }));
  const entries = await careerSitemapEntries(async () => rows);
  assert.equal(entries.length, SITEMAP_JOB_LIMIT + 3);
  assert.equal(entries.filter((entry) => entry.loc.startsWith("/career-insights/jobs/")).length, SITEMAP_JOB_LIMIT);
});
