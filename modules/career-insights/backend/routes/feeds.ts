// 就业热点 RSS：岗位、政策与最近 30 天的就业日报。只读 repository 的列表方法，数据口径与页面一致；
// 单条内容异常只跳过该条，整次查询失败才回 503。XML 全部转义（含控制字符），页面 head 里的发现链接见
// web/seo.ts 的 CAREER_FEED_LINKS（两处路径与标题保持一致）。
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "@aihot/backend/config";
import { escapeXml } from "@aihot/backend/lib/text";
import { addDays, beijingDate } from "@aihot/contracts/time";
import { SITE } from "@aihot/site";
import type { JobListItemV1, JobListResponseV1 } from "../../contracts/api.ts";
import type { CareerDailyCommentResponseV1 } from "../../contracts/insights.ts";
import type { PolicyEvidenceRefV1 } from "../../contracts/index.ts";
import type { PolicyListResponseV1 } from "../policy-read.ts";
import type { CareerRepository } from "../repository.ts";
import { STUDENT_FRIENDLY_LABELS, confidenceLabel, skillLabel } from "../../web/labels.ts";

/**
 * RSS 只用到 repository 的这三个只读方法：SqlCareerRepository 直接满足，测试可以注入假实现，
 * 新增公开出口不需要改 repository 接口。
 */
export type CareerFeedsRepository = Pick<CareerRepository, "listJobs" | "listPolicies" | "careerDailyComment">;

/** 三条 feed 的站内路径；web/seo.ts 的发现链接与这里一一对应。 */
export const CAREER_FEED_PATHS = {
  jobs: "/feed/jobs.xml",
  policies: "/feed/policies.xml",
  daily: "/feed/career-daily.xml",
} as const;

export type CareerFeedKind = keyof typeof CAREER_FEED_PATHS;

/** 岗位与政策各取最近 50 条；日报按天取最近 30 天（不是按条）。 */
export const CAREER_FEED_LIMITS = { jobs: 50, policies: 50, dailyDays: 30 } as const;

/** 读者可缓存 5 分钟；不设 s-maxage，CDN 层按部署自己的规则决定。 */
export const CAREER_FEED_CACHE_CONTROL = "public, max-age=300";
const FEED_TTL_MINUTES = 5;

const siteUrl = (path: string): string => `${config.siteUrl}${path}`;

interface ChannelMeta {
  title: string;
  description: string;
  /** 频道对应的站内页面（RSS <link>）。 */
  homePath: string;
  /** 这条 feed 自己的地址（atom:link rel=self）。 */
  selfPath: string;
}

/** 一个 RSS 2.0 频道；items 为空时也是合法的空 channel（200，而不是 404/204）。 */
function channel(meta: ChannelMeta, items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(meta.title)}</title>
    <link>${escapeXml(siteUrl(meta.homePath))}</link>
    <description>${escapeXml(meta.description)}</description>
    <language>zh-CN</language>
    <atom:link href="${escapeXml(siteUrl(meta.selfPath))}" rel="self" type="application/rss+xml" />
    <ttl>${FEED_TTL_MINUTES}</ttl>
${items.length > 0 ? `${items.join("\n")}\n` : ""}  </channel>
</rss>
`;
}

/** <pubDate> 用 RFC 822；没有可信时间就不写这一项，不拿采集时间冒充发布时间。 */
function rfc822(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toUTCString();
}

interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
  guid: string;
}

function itemXml(item: FeedItem): string {
  const pubDate = item.pubDate === null ? "" : `\n      <pubDate>${escapeXml(item.pubDate)}</pubDate>`;
  return `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <description>${escapeXml(item.description)}</description>${pubDate}
      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>
    </item>`;
}

/** 单条失败跳过：构造一条 item 时抛错（例如意外的空字段）只丢这一条，整条 feed 仍然 200。 */
function itemsOf<T>(values: readonly T[], build: (value: T) => FeedItem): string[] {
  const items: string[] = [];
  for (const value of values) {
    try {
      items.push(itemXml(build(value)));
    } catch {
      // 一条坏数据不拖垮整页。
    }
  }
  return items;
}

/** 站内岗位详情地址：与页面 canonical 同一口径（web/seo.ts 的 jobDetailPath）。 */
function jobDetailPath(id: string): string {
  return `/career-insights/jobs/${encodeURIComponent(id)}`;
}

/** 岗位标题：岗位/公司/城市（有观测到的城市才写，不猜）。 */
function jobTitle(job: JobListItemV1): string {
  const city = job.locations.length > 0 ? ` · ${job.locations.join("、")}` : "";
  return `${job.title}｜${job.company_name}${city}`;
}

/** 岗位描述：技能与学生友好标签，都是库里有的字段；不写推断。 */
function jobDescription(job: JobListItemV1): string {
  const facts: string[] = [];
  const skills = job.skills.map(skillLabel);
  if (skills.length > 0) facts.push(`技能：${skills.join("、")}`);
  if (job.student_friendly !== "unknown") facts.push(`学生友好：${STUDENT_FRIENDLY_LABELS[job.student_friendly]}`);
  return facts.join("；");
}

function jobItem(job: JobListItemV1): FeedItem {
  return {
    title: jobTitle(job),
    link: siteUrl(jobDetailPath(job.id)),
    description: jobDescription(job),
    pubDate: rfc822(job.published_at ?? job.last_seen_at),
    guid: `career-job-${job.id}`,
  };
}

function policyItem(policy: PolicyEvidenceRefV1): FeedItem {
  const excerpt = policy.evidence_excerpt.trim();
  return {
    title: policy.title,
    link: policy.official_url,
    description: `发布机构：${policy.issuer}${excerpt === "" ? "" : `；原文要点：${excerpt}`}`,
    pubDate: rfc822(policy.published_at),
    guid: `career-policy-${policy.policy_item_id}`,
  };
}

function dailyItem(comment: CareerDailyCommentResponseV1): FeedItem {
  return {
    title: `${SITE.name} 就业日报 · ${comment.date}`,
    // 站内没有按日期归档的就业日报页，历史条目统一指向日报首页（今天的日报）。
    link: siteUrl("/daily"),
    description: `当日观测样本 ${comment.sample_size} 个岗位，今日新增 ${comment.new_jobs}；置信度：${confidenceLabel(comment.confidence)}。${comment.comment}`,
    pubDate: rfc822(comment.generated_at),
    guid: `career-daily-${comment.date}`,
  };
}

/** 最近 50 个岗位，按最近观测时间倒序（repository.listJobs 的排序）。 */
export async function jobsFeed(repository: CareerFeedsRepository): Promise<string> {
  const list: JobListResponseV1 = await repository.listJobs({ page: 1, page_size: CAREER_FEED_LIMITS.jobs });
  // 联调样例是虚构岗位，不进对外 feed（与 JobPosting 结构化数据同一口径）。
  const jobs = list.data_origin === "synthetic_fixture" ? [] : list.items.slice(0, CAREER_FEED_LIMITS.jobs);
  return channel(
    {
      title: `${SITE.name} 就业岗位`,
      description: `最近观测到的就业岗位，按最近看到的时间排序，最多 ${CAREER_FEED_LIMITS.jobs} 条；每条附技能、学生友好标签与站内详情链接。`,
      homePath: "/career-insights/jobs",
      selfPath: CAREER_FEED_PATHS.jobs,
    },
    itemsOf(jobs, jobItem),
  );
}

/** 最近 50 条就业相关政策，按发布日期倒序（repository.listPolicies 的排序）。 */
export async function policiesFeed(repository: CareerFeedsRepository): Promise<string> {
  const list: PolicyListResponseV1 = await repository.listPolicies({ page: 1, page_size: CAREER_FEED_LIMITS.policies });
  const policies =
    list.data_origin === "synthetic_fixture" ? [] : list.items.slice(0, CAREER_FEED_LIMITS.policies);
  return channel(
    {
      title: `${SITE.name} 就业政策`,
      description: `政府官网发布的就业、人才培养与数字经济相关政策文件，按发布日期倒序，最多 ${CAREER_FEED_LIMITS.policies} 条；每条附发布机构与原文链接。`,
      homePath: "/career-insights/policies",
      selfPath: CAREER_FEED_PATHS.policies,
    },
    itemsOf(policies, policyItem),
  );
}

/**
 * 最近 30 天的就业日报摘要：来源是 career_daily_comments（后台 cron 预生成的缓存），
 * description 里的样本与新增数就是生成当日评论时的当日聚合，页面不重算、feed 也不重算。
 * 某一天没有缓存或读取失败就跳过那一天，feed 仍然是 200。
 */
export async function careerDailyFeed(
  repository: CareerFeedsRepository,
  { now = new Date() }: { now?: Date } = {},
): Promise<string> {
  const today = beijingDate(now);
  const dates = Array.from({ length: CAREER_FEED_LIMITS.dailyDays }, (_, index) => addDays(today, -index));
  const comments = await Promise.all(
    dates.map(async (date) => {
      try {
        return await repository.careerDailyComment(date);
      } catch {
        return null;
      }
    }),
  );
  const present = comments.filter((comment): comment is CareerDailyCommentResponseV1 => comment !== null);
  return channel(
    {
      title: `${SITE.name} 就业日报`,
      description: `最近 ${CAREER_FEED_LIMITS.dailyDays} 天的就业日报摘要：当日观测样本、新增岗位与 AI 评论。`,
      homePath: "/daily",
      selfPath: CAREER_FEED_PATHS.daily,
    },
    itemsOf(present, dailyItem),
  );
}

type FeedBuilder = (repository: CareerFeedsRepository) => Promise<string>;

async function sendFeed(
  request: FastifyRequest,
  reply: FastifyReply,
  build: FeedBuilder,
  repository: CareerFeedsRepository,
): Promise<FastifyReply> {
  try {
    const xml = await build(repository);
    return reply.header("Cache-Control", CAREER_FEED_CACHE_CONTROL).type("application/rss+xml; charset=utf-8").send(xml);
  } catch (error) {
    request.log.error({ err: error }, "career feed error");
    return reply
      .code(503)
      .header("Retry-After", "60")
      .header("Cache-Control", "no-store")
      .type("text/plain; charset=utf-8")
      .send("Feed temporarily unavailable");
  }
}

/** 由 server.ts / backend/http.ts 接线：三条只读 feed，未知查询参数忽略（与引擎现有 feed 一致）。 */
export function registerCareerFeeds(app: FastifyInstance, repository: CareerFeedsRepository): void {
  app.get(CAREER_FEED_PATHS.jobs, (request, reply) => sendFeed(request, reply, jobsFeed, repository));
  app.get(CAREER_FEED_PATHS.policies, (request, reply) => sendFeed(request, reply, policiesFeed, repository));
  app.get(CAREER_FEED_PATHS.daily, (request, reply) => sendFeed(request, reply, careerDailyFeed, repository));
}
