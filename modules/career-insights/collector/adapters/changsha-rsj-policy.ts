import type { PolicyEvidenceRefV1 } from "../../contracts/index.ts";
import type { CareerSourceDefinition } from "../index.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../sources.ts";
import { EmptyResultError, ParseFailedError, SchemaChangedError } from "../fetch/errors.ts";
import type { FetchTransport, PageRequest } from "../fetch/transport.ts";
import { loadHtmlDocument } from "../html/parse.ts";
import type { HtmlDocument } from "../html/parse.ts";
import { THEME_KEYWORDS } from "../../data/dictionaries.ts";
import { policyItemIdFromUrl } from "./policy-id.ts";
import type { PolicySourceAdapter } from "./policy-sources.ts";

/**
 * 长沙市人社局「劳动就业」公告源（就业、毕业生、补贴、培训、创业）。
 *
 * 2026-11-21 真实试抓：站点为 TRS 静态 HTML；市级「通知公告」下的劳动就业子栏目
 * /zxzx_0/tzgg_131288/ldjy_131291/ 每页 15 条（首页 15 条全部是就业/补贴/培训/毕业生类公告，
 * 共 2+ 页），条目形如
 * <li><span>2026-11-16</span><a href="./202611/t20261116_12617930.html">标题</a></li>；
 * 详情页 h1.article-title 标题、#ly 来源、.pages_zz 的「发布时间：YYYY-MM-DD HH:MM」、
 * .pages_content 正文。无 JSON、无需 Cookie/Token/签名/验证码，同域请求间隔 >= 1s。
 *
 * 访问限制（已记录，不绕过）：
 * - https://rsj.changsha.gov.cn 的 443 端口持续返回 openresty 502（首页与各栏目页均如此）；
 *   站点 <meta name="SiteDomain"> 登记的公开地址就是 http://rsj.changsha.gov.cn，故按站点自身公开地址
 *   用 http 匿名 GET。适配器不请求 https，也就不放宽 fetch 的 HTTPS→HTTP 降级门禁；明文无完整性保护，
 *   仅取公开政策原文，来源定义 notes 里写明该限制。
 * - 同类栏目（如总「通知公告」、人事人才）里有条目跳往 www.csrc.changsha.gov.cn 的 hash 路由 SPA
 *   （人才/补贴名单公示），无法静态解析；适配器只保留本站劳动就业子栏目的
 *   /zxzx_0/tzgg_131288/ldjy_131291/YYYYMM/t<id>_<n>.html 静态详情页，其他主机与路径的条目跳过而不伪造。
 */
export const CHANGSHA_RSJ_COLLECTOR_VERSION = "collector/0.1.0";
export const CHANGSHA_RSJ_SOURCE_KEY = "changsha-rsj-policy";
export const CHANGSHA_RSJ_LIST_URL =
  "http://rsj.changsha.gov.cn/zxzx_0/tzgg_131288/ldjy_131291/";

const PAGE_TIMEOUT_MS = 25_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_PAGES = 3;
const MAX_ITEMS = 10;
const EXCERPT_LENGTH = 200;
const MAX_THEMES = 3;
const MIN_BODY_LENGTH = 20;
const DEFAULT_ISSUER = "长沙市人力资源和社会保障局";
const ARTICLE_HOST = "rsj.changsha.gov.cn";
const ARTICLE_PATH_PATTERN = /^\/zxzx_0\/tzgg_131288\/ldjy_131291\/\d{6}\/t\d+_\d+\.html$/;
const LIST_DATE_PATTERN = /(\d{4})-(\d{1,2})-(\d{1,2})/;
const PAGE_DATE_PATTERN = /发布时间[:：]\s*(\d{4})-(\d{1,2})-(\d{1,2})/;
const AGENCY_MARKER = /(部|委|局|厅|署|院|政府|办公室|中心)/;
const TITLE_SUFFIX_PATTERN = /\s*-\s*长沙市人力资源和社会保障局\s*$/;

export const CHANGSHA_RSJ_SOURCE_DEFINITION: CareerSourceDefinition = {
  source_key: CHANGSHA_RSJ_SOURCE_KEY,
  label: "长沙市人力资源和社会保障局劳动就业公告",
  kind: "government_policy",
  entry_url: CHANGSHA_RSJ_LIST_URL,
  access: "http",
  enabled: false,
  notes:
    "2026-11-21 真实试抓：TRS 静态 HTML——劳动就业子栏目列表 /zxzx_0/tzgg_131288/ldjy_131291/（第 N 页 index_{N-1}.html，N=2..3），详情 /zxzx_0/tzgg_131288/ldjy_131291/YYYYMM/t<id>_<n>.html；标题 h1.article-title、来源 #ly、发布时间 .pages_zz、正文 .pages_content。https 443 持续 502（openresty），站点 SiteDomain 即 http://rsj.changsha.gov.cn，故 http 匿名 GET，明文无完整性保护；同栏目其他页面内 csrc.changsha.gov.cn 的 SPA 公示链接一律跳过。已存 2 列表 + 3 详情真实样本与离线回放用例；接线时由 lead 把 enabled 改为 true。",
};

export interface ChangshaRsjPolicyListItem {
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
}

export interface ChangshaRsjPolicyDetail {
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

/** 列表日期「2026-11-16」与详情「发布时间：2026-10-29 09:35」共用同一转换规则，输出 UTC ISO。 */
export function parseChangshaRsjPublishedDate(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const match = LIST_DATE_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }
  return toUtcDate(match[1] ?? "", match[2] ?? "", match[3] ?? "");
}

/** 详情页「发布时间：2026-10-29 09:35」；比通用日期解析更窄，避免把正文里的其他日期当发布时间。 */
function parsePagePublishedDate(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const match = PAGE_DATE_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  return toUtcDate(match[1] ?? "", match[2] ?? "", match[3] ?? "");
}

function readMetaContent(doc: HtmlDocument, name: string): string | null {
  const selectors = [
    `meta[name="${name}"]`,
    `meta[name=" ${name}"]`,
    `meta[name="${name} "]`,
    `meta[name=" ${name} "]`,
  ];
  for (const selector of selectors) {
    const value = doc.attr(selector, "content");
    if (value !== null) {
      return value.trim().length > 0 ? value.trim() : null;
    }
  }
  return null;
}

/**
 * 列表只保留本站静态详情页：外部 csrc.changsha.gov.cn 的 hash 路由 SPA 无法静态解析，
 * 跳过而不是把 SPA 壳当详情。
 */
export function parseChangshaRsjPolicyList(
  html: string,
  listUrl: string,
): ChangshaRsjPolicyListItem[] {
  const doc = loadHtmlDocument(html, listUrl);
  const seen = new Set<string>();
  const items: ChangshaRsjPolicyListItem[] = [];
  for (const entry of doc.entries(".right_list > ul > li")) {
    let parsed: URL;
    try {
      parsed = new URL(entry.href);
    } catch {
      continue;
    }
    if (parsed.hostname !== ARTICLE_HOST || !ARTICLE_PATH_PATTERN.test(parsed.pathname)) {
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
      publishedAt: parseChangshaRsjPublishedDate(entry.fullText),
    });
  }
  return items;
}

/**
 * 发文机关规则：标题「关于」前缀（如「长沙市人力资源和社会保障局关于开展…的通知」）优先；
 * 公示类标题常无机关前缀（如「长沙市2027届高校毕业生一次性求职补贴市本级复核情况公示」），
 * 此时回退到栏目固定发文机关——栏目内容均以长沙市人社局名义发布，与教育部源固定 issuer 同规则。
 */
export function resolveChangshaRsjIssuer(title: string): string {
  const aboutIndex = title.indexOf("关于");
  if (aboutIndex > 0) {
    const prefix = title.slice(0, aboutIndex).trim();
    if (prefix.length >= 2 && prefix.length <= 60 && !prefix.includes("《") && AGENCY_MARKER.test(prefix)) {
      return prefix;
    }
  }
  return DEFAULT_ISSUER;
}

export function parseChangshaRsjPolicyDetail(
  html: string,
  url: string,
  fallbackPublishedAt: string | null = null,
): ChangshaRsjPolicyDetail {
  const doc = loadHtmlDocument(html, url);
  const heading = doc.normalizedText("h1.article-title");
  const pageTitle = doc.normalizedText("title");
  const title =
    heading ?? (pageTitle === null ? null : pageTitle.replace(TITLE_SUFFIX_PATTERN, "").trim());
  if (title === null || title.length === 0) {
    throw new SchemaChangedError(`政策详情 ${url} 缺少标题`, CHANGSHA_RSJ_SOURCE_KEY);
  }

  const body = doc.text(".pages_content");
  if (body === null || body.length < MIN_BODY_LENGTH) {
    throw new SchemaChangedError(`政策详情 ${url} 正文为空或过短`, CHANGSHA_RSJ_SOURCE_KEY);
  }

  const sourceLabel = doc.normalizedText("#ly");
  return {
    sourceKey: CHANGSHA_RSJ_SOURCE_KEY,
    title,
    url,
    issuingAuthority: resolveChangshaRsjIssuer(title),
    sourceLabel,
    bodyRaw: body,
    publishedAt:
      parsePagePublishedDate(doc.normalizedText(".pages_zz")) ??
      parseChangshaRsjPublishedDate(readMetaContent(doc, "Pubdate")) ??
      fallbackPublishedAt,
  };
}

function resolveThemeIds(detail: ChangshaRsjPolicyDetail): string[] {
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

export function redactChangshaRsjPersonalData(text: string): string {
  let redacted = text;
  for (const pattern of EXCERPT_PERSONAL_DATA_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED_MARKER);
  }
  return redacted;
}

export function toChangshaRsjPolicyRef(detail: ChangshaRsjPolicyDetail): PolicyEvidenceRefV1 {
  const publishedAt = detail.publishedAt;
  if (publishedAt === null) {
    throw new ParseFailedError(`政策 ${detail.url} 缺少可解析的发布时间`, CHANGSHA_RSJ_SOURCE_KEY);
  }
  return {
    policy_item_id: policyItemIdFromUrl(detail.url).replace(/\.html$/i, ""),
    title: detail.title,
    issuer: detail.issuingAuthority,
    published_at: publishedAt.slice(0, 10),
    official_url: detail.url,
    source_tier: "government_official",
    theme_ids: resolveThemeIds(detail),
    evidence_excerpt: redactChangshaRsjPersonalData(detail.bodyRaw.replace(/\s+/g, " "))
      .slice(0, EXCERPT_LENGTH)
      .trim(),
  };
}

export interface ChangshaRsjAdapterOptions {
  readonly itemLimit?: number;
  readonly pageLimit?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 接线后以 sources.ts 的登记定义（enabled 等）为准；未登记时用本文件的常量，便于先行离线验证。 */
function resolveChangshaRsjDefinition(): CareerSourceDefinition {
  const registered = CAREER_SOURCE_DEFINITIONS.find(
    (item) => item.source_key === CHANGSHA_RSJ_SOURCE_KEY,
  );
  return registered ?? CHANGSHA_RSJ_SOURCE_DEFINITION;
}

function buildRequest(url: string, signal: AbortSignal | undefined): PageRequest {
  return {
    url,
    method: "GET",
    headers: { accept: "text/html" },
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    sourceKey: CHANGSHA_RSJ_SOURCE_KEY,
    ...(signal === undefined ? {} : { signal }),
  };
}

/** 列表分页地址：第 1 页是栏目首页，第 N 页（N=2..3）为 index_{N-1}.html（kkpager 0 基）。 */
export function changshaRsjPolicyListPageUrl(page: number): string {
  return page === 1
    ? CHANGSHA_RSJ_LIST_URL
    : new URL(`index_${page - 1}.html`, CHANGSHA_RSJ_LIST_URL).toString();
}

export function createChangshaRsjPolicyAdapter(
  transport: FetchTransport,
  options: ChangshaRsjAdapterOptions = {},
): PolicySourceAdapter {
  const definition = resolveChangshaRsjDefinition();
  const itemLimit = Math.max(1, Math.min(options.itemLimit ?? 3, MAX_ITEMS));
  const pageLimit = Math.max(1, Math.min(options.pageLimit ?? 1, MAX_PAGES));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    definition,
    async collect(signal?: AbortSignal): Promise<PolicyEvidenceRefV1[]> {
      const seen = new Set<string>();
      const listItems: ChangshaRsjPolicyListItem[] = [];
      for (let page = 1; page <= pageLimit; page += 1) {
        if (signal?.aborted === true) {
          throw new DOMException("采集被取消", "AbortError");
        }
        if (page > 1) {
          await sleep(MIN_INTERVAL_MS);
        }
        const url = changshaRsjPolicyListPageUrl(page);
        const response = await transport.fetchPage(buildRequest(url, signal));
        const items = parseChangshaRsjPolicyList(response.body.toString("utf8"), url);
        if (items.length === 0) {
          if (page === 1) {
            throw new EmptyResultError(`政策列表 ${url} 未解析出任何条目`, CHANGSHA_RSJ_SOURCE_KEY);
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
          `政策列表 ${CHANGSHA_RSJ_LIST_URL} 未解析出任何条目`,
          CHANGSHA_RSJ_SOURCE_KEY,
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
        const detail = parseChangshaRsjPolicyDetail(
          response.body.toString("utf8"),
          item.url,
          item.publishedAt,
        );
        try {
          out.push(toChangshaRsjPolicyRef(detail));
        } catch (error) {
          skipped.push(`${item.url} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (skipped.length > 0) {
        throw new ParseFailedError(
          `政策解析失败 ${skipped.length}/${targets.length} 条，拒绝静默丢弃：${skipped.join("; ")}`,
          CHANGSHA_RSJ_SOURCE_KEY,
        );
      }
      return out;
    },
  };
}
