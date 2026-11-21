// 岗位详情与职业洞察/政策/岗位列表页在搜索结果里的元数据：标题、描述、canonical、结构化数据，以及
// 页面 head 里的 RSS 发现链接。页面（web/routes/*.tsx）的 meta 只把 loader 数据交给这里，测试也断言这里，
// 文案与构造只写一份。站点名后缀、og:*、robots 由 @aihot/web/lib/seo 的 pageMeta 统一加。
//
// 分享图：岗位详情、岗位列表、洞察与政策页都用 pageMeta 默认的 /og/site.png。页面级分享图
// （/og/pages/<name>.png）的文字配置在 site/site.ts 的 CARDS（站点配置，不属于本模块），引擎 og 核心
// 也不在本模块的改动范围，所以这里不新增 career 页面卡，统一用默认分享图。
import type { MetaDescriptor } from "react-router";
import { breadcrumbLd, pageMeta, siteUrl } from "@aihot/web/lib/seo";
import { SITE } from "@aihot/site";
import type { DataOrigin, EmploymentType } from "../contracts/index.ts";
import type { JobDetailResponseV1, JobDetailV1, JobListResponseV1 } from "../contracts/api.ts";
import type { CareerDailyResponseV1 } from "../contracts/insights.ts";
import { EMPLOYMENT_TYPE_LABELS, ROLE_FAMILY_LABELS, STUDENT_FRIENDLY_LABELS, skillLabel } from "./labels.ts";

/** 岗位详情页地址；canonical、JobPosting 的 @id 与 ItemList 的条目 url 都用它，查询参数（如 back）不进地址。 */
export function jobDetailPath(id: string): string {
  return `/career-insights/jobs/${encodeURIComponent(id)}`;
}

/** 职业洞察页在搜索结果里的地址。 */
export const DASHBOARD_PATH = "/career-insights";
/** 岗位列表页在搜索结果里的地址；关键词只改结果视图，canonical 固定指向这一页。 */
export const JOBS_PATH = "/career-insights/jobs";
/** 政策文件页在搜索结果里的地址；来源/主题筛选是浏览视图，canonical 始终回到这一页。 */
export const POLICIES_PATH = "/career-insights/policies";
/** 就业日报页在搜索结果里的地址（站内唯一的日报页，按天更新）。 */
export const DAILY_PATH = "/daily";

/**
 * 页面 head 里的 RSS 发现链接。<path> 与 backend/routes/feeds.ts 的 CAREER_FEED_PATHS 一一对应，
 * <title> 与那里的频道标题一致；两处都写死是为了不让后端路由进浏览器构建，测试会校验路径没漂移。
 */
const CAREER_FEEDS = {
  jobs: { path: "/feed/jobs.xml", title: `${SITE.name} 就业岗位` },
  policies: { path: "/feed/policies.xml", title: `${SITE.name} 就业政策` },
  daily: { path: "/feed/career-daily.xml", title: `${SITE.name} 就业日报` },
} as const;

export type CareerFeedKind = keyof typeof CAREER_FEEDS;

/** 一条 RSS 发现链接；路由 meta 直接把它追加在 pageMeta 返回的 tag 后面（与引擎报告页的 feedLink 同一写法）。 */
export function careerFeedLink(kind: CareerFeedKind): MetaDescriptor {
  const feed = CAREER_FEEDS[kind];
  return { tagName: "link", rel: "alternate", type: "application/rss+xml", title: feed.title, href: feed.path };
}

/** 结构化数据里列表最多列前 20 条：与页面第一页展示的数量一致，不把整库写进一份 JSON-LD。 */
export const STRUCTURED_LIST_LIMIT = 20;

/**
 * 政策列表页 meta 需要的最小字段：后端契约（PolicyListResponseV1）与 web/policy.ts 的页面响应
 * （facets 可选）都满足，结构化数据只用标题与政府原文地址，不依赖分面。
 */
export interface CareerPoliciesMetaInput {
  data_origin: DataOrigin;
  items: ReadonlyArray<{ title: string; official_url: string }>;
}

/** 观测摘录是抓取到的原文片段：去掉标签、还原几个常见实体、压掉换行，只留纯文本。 */
function plainText(value: string, limit: number): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** 事实短语里只放短值：抓取到的整句（含标点/换行/超长）不当作学历或经验写进 meta。 */
const FACT_MAX_CHARS = 16;
function shortFact(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length === 0 || text.length > FACT_MAX_CHARS) return null;
  if (/[。；;，,、！!？?\n]/.test(text)) return null;
  return text;
}

/** 岗位已知字段拼成的事实短语：只写库里有的值，缺的、unknown 的不编。 */
function jobFacts(job: JobDetailV1): string[] {
  const facts: string[] = [];
  if (job.locations.length > 0) facts.push(`城市：${job.locations.join("、")}`);
  if (job.role_family !== "unknown") facts.push(`职位类别：${ROLE_FAMILY_LABELS[job.role_family]}`);
  if (job.employment_type !== "unknown") facts.push(`用工类型：${EMPLOYMENT_TYPE_LABELS[job.employment_type]}`);
  if (job.student_friendly !== "unknown") facts.push(`学生友好：${STUDENT_FRIENDLY_LABELS[job.student_friendly]}`);
  const degree = shortFact(job.degree_raw);
  if (degree) facts.push(`学历：${degree}`);
  const experience = shortFact(job.experience_raw);
  if (experience) facts.push(`经验：${experience}`);
  const skills = job.skills.slice(0, 6).map(skillLabel);
  if (skills.length > 0) facts.push(`技能：${skills.join("、")}`);
  return facts;
}

/** 搜索结果的描述：公司与职位名加上库里的城市/职族/用工类型/学生友好等事实，不写没有依据的判断。 */
export function jobDescription(job: JobDetailV1): string {
  const facts = jobFacts(job);
  return `${job.company_name}招聘「${job.title}」${facts.length > 0 ? `：${facts.join("；")}` : ""}。岗位信息来自该公司的官方招聘页的公开观测，以原文为准。`;
}

/** schema.org 的用工类型：只知道笼统方向的不猜。 */
function schemaEmploymentType(type: EmploymentType): string | null {
  return ({ campus: "FULL_TIME", internship: "INTERN", experienced: "FULL_TIME", other: "OTHER", unknown: null })[type] ?? null;
}

/** 工作地点：国家固定 CN；有城市时各地一个 Place，多个城市给数组。 */
function jobLocation(locations: string[]) {
  const place = (city?: string) => ({
    "@type": "Place",
    address: { "@type": "PostalAddress", addressCountry: "CN", ...(city ? { addressLocality: city } : {}) },
  });
  return locations.length > 1 ? locations.map((city) => place(city)) : place(locations[0]);
}

/**
 * JobPosting 的 description：结构化字段一句，加上最近一条观测摘录（与页面展示的是同一段，raw_text 前
 * EXCERPT_LIMIT 字符）；契约不公开完整 raw_text，不另编内容。截到 800 字，去 HTML 后只留纯文本。
 */
export function jobPostingDescription(detail: JobDetailResponseV1): string {
  const job = detail.job;
  const facts = jobFacts(job);
  const heading = `招聘岗位：${job.title}；公司：${job.company_name}${facts.length > 0 ? `；${facts.join("；")}` : ""}`;
  const excerpt = detail.observations[0]?.evidence_excerpt;
  return plainText(`${heading}\n\n${excerpt ?? ""}`, 800);
}

/** 发布日期优先用来源给的可信 published_at（未来/不可解析时退回首次观测时间）。 */
function jobPublishedDate(job: JobDetailV1): string {
  const published = job.published_at;
  if (published) {
    const ms = Date.parse(published);
    if (!Number.isNaN(ms) && ms <= Date.now() + 86_400_000) return published;
  }
  return job.first_seen_at;
}

/**
 * 岗位详情页的 JobPosting 结构化数据；联调样例（synthetic_fixture）是虚构职位，返回 null 不输出。
 * 不写 validThrough：岗位是否仍在招以最近一次观测为准，写一个过期日会误导搜索引擎与读者。
 */
export function jobPostingLd(detail: JobDetailResponseV1): Record<string, unknown> | null {
  if (detail.data_origin === "synthetic_fixture") return null;
  const job = detail.job;
  const employmentType = schemaEmploymentType(job.employment_type);
  return {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "@id": `${siteUrl()}${jobDetailPath(job.id)}#jobposting`,
    title: job.title,
    datePosted: jobPublishedDate(job),
    hiringOrganization: { "@type": "Organization", name: job.company_name },
    jobLocation: jobLocation(job.locations),
    ...(employmentType ? { employmentType } : {}),
    description: jobPostingDescription(detail),
    directApply: false,
  };
}

/**
 * 面包屑：首页 → 职业洞察 → 页面自己（职位详情再落到职位名）。只写站内真实存在的页面路径，
 * 岗位详情沿用 canonical 地址，不把筛选/搜索参数写进去。
 */
export function careerBreadcrumbLd(...trail: Array<{ name: string; path: string }>): Record<string, unknown> {
  return breadcrumbLd([
    { name: "首页", path: "/" },
    { name: "职业洞察", path: DASHBOARD_PATH },
    ...trail,
  ]);
}

/**
 * 岗位列表的 ItemList：前 20 个岗位，name 用职位名、url 用站内详情页地址，都是库里/路由里已有的值。
 * 联调样例是虚构职位，返回 null；列表为空也不输出空 ItemList。
 */
export function jobsItemListLd(list: JobListResponseV1 | undefined): Record<string, unknown> | null {
  if (list === undefined || list.data_origin === "synthetic_fixture") return null;
  const jobs = list.items.slice(0, STRUCTURED_LIST_LIMIT);
  if (jobs.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${siteUrl()}${JOBS_PATH}#itemlist`,
    name: `${SITE.name} 热门岗位`,
    url: `${siteUrl()}${JOBS_PATH}`,
    numberOfItems: jobs.length,
    itemListElement: jobs.map((job, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: job.title,
      url: `${siteUrl()}${jobDetailPath(job.id)}`,
    })),
  };
}

/**
 * 政策列表的 ItemList：前 20 条政策，name 用政策标题、url 用政府原文地址（站内没有单条政策页）。
 * 联调样例是虚构政策，返回 null；列表为空也不输出空 ItemList。
 */
export function policiesItemListLd(list: CareerPoliciesMetaInput | undefined): Record<string, unknown> | null {
  if (list === undefined || list.data_origin === "synthetic_fixture") return null;
  const policies = list.items.slice(0, STRUCTURED_LIST_LIMIT);
  if (policies.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${siteUrl()}${POLICIES_PATH}#itemlist`,
    name: `${SITE.name} 政策文件`,
    url: `${siteUrl()}${POLICIES_PATH}`,
    numberOfItems: policies.length,
    itemListElement: policies.map((policy, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: policy.title,
      url: policy.official_url,
    })),
  };
}

/** 至少一块结构化数据才交给 pageMeta：空数组也算有值，会渲染成一个空的 JSON-LD script。 */
function jsonLdOf(...blocks: Array<Record<string, unknown> | null>): Record<string, unknown>[] | undefined {
  const present = blocks.filter((block): block is Record<string, unknown> => block !== null);
  return present.length > 0 ? present : undefined;
}

/** 职位详情页的 meta：标题是职位名（pageMeta 会自动接「 · 站名」），canonical 带 id。 */
export function jobMeta(detail: JobDetailResponseV1): MetaDescriptor[] {
  return pageMeta({
    title: detail.job.title,
    description: jobDescription(detail.job),
    path: jobDetailPath(detail.job.id),
    type: "article",
    noindex: detail.data_origin === "synthetic_fixture",
    // 联调样例不索引，也不输出结构化数据（职位名是虚构的，Breadcrumb 也不列）。
    jsonLd:
      detail.data_origin === "synthetic_fixture"
        ? undefined
        : jsonLdOf(
            jobPostingLd(detail),
            careerBreadcrumbLd(
              { name: "热门岗位", path: JOBS_PATH },
              { name: detail.job.title, path: jobDetailPath(detail.job.id) },
            ),
          ),
  });
}

/** 职业洞察页的 meta；联调样例不索引。 */
export function careerDashboardMeta(dataOrigin?: DataOrigin): MetaDescriptor[] {
  return [
    ...pageMeta({
      title: "职业洞察：岗位职族、技能需求与政策动向",
      description: "岗位与政策的结构化洞察：职族占比、技能需求、学生友好职位与政策共享主题，数据来自官方招聘与政府公开来源，随每日观测更新。",
      path: DASHBOARD_PATH,
      noindex: dataOrigin === "synthetic_fixture",
      jsonLd: careerBreadcrumbLd(),
    }),
    careerFeedLink("jobs"),
  ];
}

export interface CareerJobsMetaInput {
  /** 搜索关键词；只改这一页的结果视图，canonical 仍是不带查询的列表页。 */
  keyword?: string | null;
  jobs?: JobListResponseV1;
}

/**
 * 岗位列表页的 meta：关键词只影响标题/描述，canonical 固定到列表页；结构化数据是前 20 个岗位的
 * ItemList 加面包屑，页面 head 里带岗位 RSS 发现链接。
 */
export function careerJobsMeta(input: CareerJobsMetaInput = {}): MetaDescriptor[] {
  const keyword = input.keyword ?? undefined;
  return [
    ...pageMeta({
      title: keyword ? `岗位搜索：${keyword}` : "热门岗位",
      description: keyword
        ? `「${keyword}」相关岗位：按职位名、公司、技能与城市搜索当前有效岗位，每条岗位附官方原文链接。`
        : "按职族与职位聚合的当前有效岗位，可按关键词、学生友好与城市筛选，每条岗位附官方原文链接。",
      path: JOBS_PATH,
      // 搜索结果是同一列表页的视图，不登记成独立页面；ItemList 只放在无关键词的干净列表上。
      noindex: Boolean(keyword),
      jsonLd: jsonLdOf(keyword ? null : jobsItemListLd(input.jobs), careerBreadcrumbLd({ name: "热门岗位", path: JOBS_PATH })),
    }),
    careerFeedLink("jobs"),
  ];
}

/** 政策文件页的 meta；联调样例不索引，筛选是浏览视图（canonical 回到政策页本身）。 */
export function careerPoliciesMeta(policies?: CareerPoliciesMetaInput): MetaDescriptor[] {
  return [
    ...pageMeta({
      title: "政策文件：就业与人才培养政策原文汇总",
      description: "汇总政府官网发布的就业、人才培养与数字经济相关政策文件，按来源与主题筛选，附原文链接。",
      path: POLICIES_PATH,
      noindex: policies?.data_origin === "synthetic_fixture",
      jsonLd: jsonLdOf(policiesItemListLd(policies), careerBreadcrumbLd({ name: "政策文件", path: POLICIES_PATH })),
    }),
    careerFeedLink("policies"),
  ];
}

/** 就业日报页的 meta：标题带日报日期（有数据时），head 里带就业日报 RSS 发现链接。 */
export function careerDailyMeta(daily?: CareerDailyResponseV1): MetaDescriptor[] {
  const date = daily?.date;
  return [
    ...pageMeta({
      title: `就业日报${date ? `（${date}）` : ""}`,
      description: "今日新增岗位与政策、各来源采集结果，以及空技能岗位占比。",
      path: DAILY_PATH,
      image: "/og/pages/daily.png",
    }),
    careerFeedLink("daily"),
  ];
}
