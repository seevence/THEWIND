// career-insights 在站点 sitemap 里的条目：三个索引页，加上存在岗位的详情页。
// packages/backend/src/publication/sitemap.ts 从 ServerModule.sitemap.entries 追加；只读本模块自己的表，
// 不经过页面和 API，岗位是否"存在"就是 career_jobs 里有没有这一行。
import { sql } from "@aihot/backend/db";
import type { SitemapEntry } from "@aihot/backend/modules";

/**
 * 岗位详情 URL 的上限：sitemap 每 5 分钟建一次、整份上限 45k 条；按 last_seen_at 取最近观测的五千个，
 * 老岗位留在站内但不逐条写进 sitemap。
 */
export const SITEMAP_JOB_LIMIT = 5_000;

/** 一个岗位的 sitemap 行；last_seen_at 就是它的 lastmod。 */
export interface SitemapJobRow {
  id: string;
  last_seen_at: Date | string;
}

export type LoadSitemapJobs = () => Promise<SitemapJobRow[]>;

/** 三个索引页：职业洞察、热门岗位、政策文件。就业日报与热度榜已由引擎的静态页列表收录，不重复。 */
const INDEX_PAGES: readonly SitemapEntry[] = [
  { loc: "/career-insights", changefreq: "daily", priority: 0.8 },
  { loc: "/career-insights/jobs", changefreq: "daily", priority: 0.8 },
  { loc: "/career-insights/policies", changefreq: "weekly", priority: 0.7 },
];

/** 最近观测的岗位：主键行都在，所以列出的每个 URL 都指向存在的岗位。 */
async function loadSitemapJobs(): Promise<SitemapJobRow[]> {
  return sql<SitemapJobRow[]>`
    SELECT id::text AS id, last_seen_at
    FROM career_jobs
    ORDER BY last_seen_at DESC, id DESC
    LIMIT ${SITEMAP_JOB_LIMIT}`;
}

/** 注入的行数也截到上限：SQL 已经 LIMIT，这里兜一层，换数据源时 sitemap 不会被撑大。测试也用它注入假数据。 */
export async function careerSitemapEntries(loadJobs: LoadSitemapJobs = loadSitemapJobs): Promise<SitemapEntry[]> {
  const jobs = (await loadJobs()).slice(0, SITEMAP_JOB_LIMIT);
  return [
    ...INDEX_PAGES,
    ...jobs.map((job) => ({
      loc: `/career-insights/jobs/${encodeURIComponent(job.id)}`,
      lastmod: job.last_seen_at instanceof Date ? job.last_seen_at : new Date(job.last_seen_at),
      changefreq: "weekly",
      priority: 0.5,
    })),
  ];
}
