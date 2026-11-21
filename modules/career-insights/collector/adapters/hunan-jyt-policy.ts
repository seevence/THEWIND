import type { PolicyEvidenceRefV1 } from "../../contracts/index.ts";
import type { CareerSourceDefinition } from "../index.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../sources.ts";
import { EmptyResultError, ParseFailedError, SchemaChangedError } from "../fetch/errors.ts";
import type { FetchTransport, PageRequest } from "../fetch/transport.ts";
import { loadHtmlDocument } from "../html/parse.ts";
import { THEME_KEYWORDS } from "../../data/dictionaries.ts";
import { policyItemIdFromUrl } from "./policy-id.ts";
import type { PolicySourceAdapter } from "./policy-sources.ts";

/**
 * 湖南省教育厅通知公告源（招生、毕业生、人才、培训）。
 *
 * 2026-11-21 真实试抓：省级教育行政部门 TRS 静态 HTML，列表 /jyt/sjyt/xxgk/tzgg/index.html
 * 每页 20 条、共 25 页，条目形如
 * <li><a href="/jyt/sjyt/xxgk/tzgg/202611/t20261120_1184219.html" title="…">标题（列表内截断）</a><span>2026-11-20</span></li>；
 * 详情页 .main_content h2 标题、.sp_time 首段「湖南省教育厅 jyt.hunan.gov.cn」与
 * .sp_time .time 的「发布时间：YYYY-MM-DD HH:MM」、.main_con_zw（#j-show-body）正文。
 * 无 Cookie/Token/签名/验证码；同域请求间隔 >= 1s，最多 3 页、每批最多 10 条；全站 HTTPS 直连无降级。
 *
 * 2026-11-21 试抓时 https://jyt.hunan.gov.cn/robots.txt 返回站点 404 页面（无 robots 规则），
 * 首页与列表/详情均为 200 静态页；未见 403/405/验证码。
 */
export const HUNAN_JYT_COLLECTOR_VERSION = "collector/0.1.0";
export const HUNAN_JYT_SOURCE_KEY = "hunan-jyt-policy";
export const HUNAN_JYT_LIST_URL = "https://jyt.hunan.gov.cn/jyt/sjyt/xxgk/tzgg/index.html";

const PAGE_TIMEOUT_MS = 25_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_PAGES = 3;
const MAX_ITEMS = 10;
const EXCERPT_LENGTH = 200;
const MAX_THEMES = 3;
const MIN_BODY_LENGTH = 20;
const DEFAULT_ISSUER = "湖南省教育厅";
const ARTICLE_PATH_PATTERN = /^\/jyt\/sjyt\/xxgk\/tzgg\/\d{6}\/t\d+_\d+\.html$/;
const LIST_DATE_PATTERN = /(\d{4})-(\d{1,2})-(\d{1,2})/g;
const PAGE_DATE_PATTERN = /发布时间[:：]\s*(\d{4})-(\d{1,2})-(\d{1,2})/;
const AGENCY_MARKER = /(部|委|局|厅|署|院|政府|办公室|中心)/;
const TITLE_SUFFIX_PATTERN = /\s*-\s*湖南省教育厅\s*$/;

export const HUNAN_JYT_SOURCE_DEFINITION: CareerSourceDefinition = {
  source_key: HUNAN_JYT_SOURCE_KEY,
  label: "湖南省教育厅通知公告",
  kind: "government_policy",
  entry_url: HUNAN_JYT_LIST_URL,
  access: "http",
  enabled: false,
  notes:
    "2026-11-21 真实试抓：TRS 静态 HTML——列表 /jyt/sjyt/xxgk/tzgg/index.html（第 N 页 index_{N}.html，N=2..3），详情 /jyt/sjyt/xxgk/tzgg/YYYYMM/t<id>_<n>.html；标题 .main_content h2、来源与发布时间 .sp_time、正文 .main_con_zw（#j-show-body）。HTTPS 直连 200、无 Cookie/Token/签名/验证码、robots.txt 无规则。已存 2 列表 + 3 详情真实样本与离线回放用例；接线时由 lead 把 enabled 改为 true。",
};

export interface HunanJytPolicyListItem {
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
}

export interface HunanJytPolicyDetail {
  readonly sourceKey: string;
  readonly title: string;
  readonly url: string;
  readonly issuingAuthority: string;
  readonly sourceLabel: string | null;
  readonly bodyRaw: string;
  readonly publishedAt: string | null;
}

function toUtcDate(year: string, month: string, day: string): string | null {
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : iso;
}

/**
 * 列表项日期在标题链接之后（<a>标题</a><span>2026-11-20</span>），取同项文本里最后一个
 * YYYY-MM-DD；标题里的「2026年度」「2026年10月」不匹配该格式。
 */
export function parseHunanJytListDate(fullText: string): string | null {
  const matches = [...fullText.matchAll(LIST_DATE_PATTERN)];
  const last = matches.at(-1);
  if (last === undefined) {
    return null;
  }
  return toUtcDate(last[1] ?? "", last[2] ?? "", last[3] ?? "");
}

/** 详情页「发布时间：2026-10-16 15:09」；列表页日期作回退。 */
export function parseHunanJytPageDate(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const match = PAGE_DATE_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  return toUtcDate(match[1] ?? "", match[2] ?? "", match[3] ?? "");
}

export function parseHunanJytPolicyList(
  html: string,
  listUrl: string,
): HunanJytPolicyListItem[] {
  const doc = loadHtmlDocument(html, listUrl);
  const seen = new Set<string>();
  const items: HunanJytPolicyListItem[] = [];
  for (const entry of doc.entries("ul.list_gkzd_content > li")) {
    let parsed: URL;
    try {
      parsed = new URL(entry.href);
    } catch {
      continue;
    }
    if (!ARTICLE_PATH_PATTERN.test(parsed.pathname)) {
      continue;
    }
    const url = parsed.toString();
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    items.push({
      title: entry.text,
      url,
      publishedAt: parseHunanJytListDate(entry.fullText),
    });
  }
  return items;
}

/**
 * 发文机关规则：标题「关于」前缀（如「湖南省教育厅关于做好…的通知」）优先；
 * 公示、名单类标题常无机关前缀，回退到详情页 .sp_time 的来源（「湖南省教育厅 jyt.hunan.gov.cn」）
 * 取首个词，再回退到栏目固定发文机关（与教育部源固定 issuer 同规则）。
 */
export function resolveHunanJytIssuer(title: string, sourceLabel: string | null): string {
  const aboutIndex = title.indexOf("关于");
  if (aboutIndex > 0) {
    const prefix = title.slice(0, aboutIndex).trim();
    if (prefix.length >= 2 && prefix.length <= 60 && !prefix.includes("《") && AGENCY_MARKER.test(prefix)) {
      return prefix;
    }
  }
  if (sourceLabel !== null) {
    const source = sourceLabel.trim().split(/\s+/)[0] ?? "";
    if (source.length >= 2 && source.length <= 60 && AGENCY_MARKER.test(source)) {
      return source;
    }
  }
  return DEFAULT_ISSUER;
}

export function parseHunanJytPolicyDetail(
  html: string,
  url: string,
  fallbackPublishedAt: string | null = null,
): HunanJytPolicyDetail {
  const doc = loadHtmlDocument(html, url);
  const heading = doc.normalizedText(".main_content h2");
  const pageTitle = doc.normalizedText("title");
  const title =
    heading ?? (pageTitle === null ? null : pageTitle.replace(TITLE_SUFFIX_PATTERN, "").trim());
  if (title === null || title.length === 0) {
    throw new SchemaChangedError(`政策详情 ${url} 缺少标题`, HUNAN_JYT_SOURCE_KEY);
  }

  const body = doc.text(".main_con_zw");
  if (body === null || body.length < MIN_BODY_LENGTH) {
    throw new SchemaChangedError(`政策详情 ${url} 正文为空或过短`, HUNAN_JYT_SOURCE_KEY);
  }

  const sourceLabel = doc.normalizedText(".sp_time > span");
  return {
    sourceKey: HUNAN_JYT_SOURCE_KEY,
    title,
    url,
    issuingAuthority: resolveHunanJytIssuer(title, sourceLabel),
    sourceLabel,
    bodyRaw: body,
    publishedAt:
      parseHunanJytPageDate(doc.normalizedText(".sp_time .time")) ?? fallbackPublishedAt,
  };
}

function resolveThemeIds(detail: HunanJytPolicyDetail): string[] {
  const haystack = `${detail.title}\n${detail.bodyRaw}`.toLowerCase();
  const themes: string[] = [];
  for (const [themeId, keywords] of Object.entries(THEME_KEYWORDS)) {
    if (themes.length >= MAX_THEMES) break;
    if (keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
      themes.push(themeId);
    }
  }
  return themes;
}

/**
 * 与 evidence/sanitizer.ts 的 containsPersonalData 规则同源：摘录里命中的邮箱、手机号、
 * 联系段落替换为固定占位，保证公开的 evidence_excerpt 不携带个人联系方式。
 */
const EXCERPT_PERSONAL_DATA_PATTERNS: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /(?:^|[^\d])1[3-9]\d{9}(?!\d)/g,
  /(?:联系人|联系方式|联系电话|简历投递)\s*[:：][^\n]{0,40}/g,
];
const REDACTED_MARKER = "〔联系方式已隐去〕";

export function redactHunanJytPersonalData(text: string): string {
  let redacted = text;
  for (const pattern of EXCERPT_PERSONAL_DATA_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED_MARKER);
  }
  return redacted;
}

export function toHunanJytPolicyRef(detail: HunanJytPolicyDetail): PolicyEvidenceRefV1 {
  const publishedAt = detail.publishedAt;
  if (publishedAt === null) {
    throw new ParseFailedError(`政策 ${detail.url} 缺少可解析的发布时间`, HUNAN_JYT_SOURCE_KEY);
  }
  return {
    policy_item_id: policyItemIdFromUrl(detail.url).replace(/\.html$/i, ""),
    title: detail.title,
    issuer: detail.issuingAuthority,
    published_at: publishedAt.slice(0, 10),
    official_url: detail.url,
    source_tier: "government_official",
    theme_ids: resolveThemeIds(detail),
    evidence_excerpt: redactHunanJytPersonalData(detail.bodyRaw.replace(/\s+/g, " "))
      .slice(0, EXCERPT_LENGTH)
      .trim(),
  };
}

export interface HunanJytAdapterOptions {
  readonly itemLimit?: number;
  readonly pageLimit?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 接线后以 sources.ts 的登记定义（enabled 等）为准；未登记时用本文件的常量，便于先行离线验证。 */
function resolveHunanJytDefinition(): CareerSourceDefinition {
  const registered = CAREER_SOURCE_DEFINITIONS.find(
    (item) => item.source_key === HUNAN_JYT_SOURCE_KEY,
  );
  return registered ?? HUNAN_JYT_SOURCE_DEFINITION;
}

function buildRequest(url: string, signal: AbortSignal | undefined): PageRequest {
  return {
    url,
    method: "GET",
    headers: { accept: "text/html" },
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    sourceKey: HUNAN_JYT_SOURCE_KEY,
    ...(signal === undefined ? {} : { signal }),
  };
}

/** 列表分页地址：第 1 页是栏目首页，第 N 页（N=2..3）为 index_N.html（工信部/TRS 1 基）。 */
export function hunanJytPolicyListPageUrl(page: number): string {
  return page === 1
    ? HUNAN_JYT_LIST_URL
    : new URL(`index_${page}.html`, HUNAN_JYT_LIST_URL).toString();
}

export function createHunanJytPolicyAdapter(
  transport: FetchTransport,
  options: HunanJytAdapterOptions = {},
): PolicySourceAdapter {
  const definition = resolveHunanJytDefinition();
  const itemLimit = Math.max(1, Math.min(options.itemLimit ?? 3, MAX_ITEMS));
  const pageLimit = Math.max(1, Math.min(options.pageLimit ?? 1, MAX_PAGES));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    definition,
    async collect(signal?: AbortSignal): Promise<PolicyEvidenceRefV1[]> {
      const seen = new Set<string>();
      const listItems: HunanJytPolicyListItem[] = [];
      for (let page = 1; page <= pageLimit; page += 1) {
        if (signal?.aborted === true) {
          throw new DOMException("采集被取消", "AbortError");
        }
        if (page > 1) {
          await sleep(MIN_INTERVAL_MS);
        }
        const url = hunanJytPolicyListPageUrl(page);
        const response = await transport.fetchPage(buildRequest(url, signal));
        const items = parseHunanJytPolicyList(response.body.toString("utf8"), url);
        if (items.length === 0) {
          if (page === 1) {
            throw new EmptyResultError(`政策列表 ${url} 未解析出任何条目`, HUNAN_JYT_SOURCE_KEY);
          }
          break;
        }
        for (const item of items) {
          if (seen.has(item.url)) {
            continue;
          }
          seen.add(item.url);
          listItems.push(item);
        }
        if (listItems.length >= itemLimit) {
          break;
        }
      }

      const targets = listItems.slice(0, itemLimit);
      if (targets.length === 0) {
        throw new EmptyResultError(
          `政策列表 ${HUNAN_JYT_LIST_URL} 未解析出任何条目`,
          HUNAN_JYT_SOURCE_KEY,
        );
      }

      const out: PolicyEvidenceRefV1[] = [];
      const skipped: string[] = [];
      for (const item of targets) {
        if (signal?.aborted === true) {
          throw new DOMException("采集被取消", "AbortError");
        }
        await sleep(MIN_INTERVAL_MS);
        const response = await transport.fetchPage(buildRequest(item.url, signal));
        const detail = parseHunanJytPolicyDetail(
          response.body.toString("utf8"),
          item.url,
          item.publishedAt,
        );
        try {
          out.push(toHunanJytPolicyRef(detail));
        } catch (error) {
          skipped.push(`${item.url} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (skipped.length > 0) {
        throw new ParseFailedError(
          `政策解析失败 ${skipped.length}/${targets.length} 条，拒绝静默丢弃：${skipped.join("; ")}`,
          HUNAN_JYT_SOURCE_KEY,
        );
      }
      return out;
    },
  };
}
