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
 * 人社部就业政策源（中国就业网「最新政策 - 中央」栏目）。
 *
 * 2026-11-21 真实试抓：部委主站 www.mohrss.gov.cn 全部栏目页返回 EdgeOne JS 混淆挑战
 * （EO_Bot_Ssid cookie + _0x 混淆脚本），按 access_blocked 记录、不绕过；人社部主办的中国就业网
 * chinajob.mohrss.gov.cn 公开静态 HTML 可直接读取，故把政策入口定在该子域的「中央」政策栏目，
 * 只取国家级就业/人才政策，地方栏目与本适配器无关。
 *
 * 列表页：GET https://chinajob.mohrss.gov.cn/zcfg/zxzc/zy/（第 N 页 index_N.shtml，最多取 3 页）
 * 详情页：GET /c/YYYY-MM-DD/<id>.shtml
 * 列表项为 <li>：标题链接 <a href="/c/...">、无独立日期字段，发布日期取 URL 路径段 YYYY-MM-DD；
 * 详情页 h4 标题、.detail_info .link 为来源机构、.detail_info .date 为 YYYY.MM.DD、.detail_article 为正文。
 * 两个页面都是 text/html，无 JSON、无需 Cookie/Token/签名/验证码，同域请求间隔 >= 1s。
 */
export const MOHRSS_COLLECTOR_VERSION = "collector/0.1.0";
export const MOHRSS_POLICY_SOURCE_KEY = "mohrss-policy";
export const MOHRSS_POLICY_LIST_URL = "https://chinajob.mohrss.gov.cn/zcfg/zxzc/zy/";

const PAGE_TIMEOUT_MS = 25_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_PAGES = 3;
const MAX_ITEMS = 10;
const EXCERPT_LENGTH = 200;
const MAX_THEMES = 3;
const MIN_BODY_LENGTH = 20;
const ITEM_PATH_PATTERN = /\/c\/(\d{4})-(\d{2})-(\d{2})\/\d+\.shtml$/;
const PAGE_DATE_PATTERN = /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/;
const AGENCY_MARKER = /(部|委|局|厅|署|院|政府|办公室|中心)/;
const LEADING_AGENCY_PATTERN = /^([\u4e00-\u9fa5A-Za-z0-9（）()·、,\s]{2,60}?)(?:修改|发布|印发|公布|修订|废止)/;
const REGULATION_ISSUER_PATTERN = /^（\s*\d{4}年\d{1,2}月\d{1,2}日(.+?)(?:令第[\d]+号)?公布/;

export const MOHRSS_SOURCE_DEFINITION: CareerSourceDefinition = {
  source_key: MOHRSS_POLICY_SOURCE_KEY,
  label: "中国就业网（人力资源社会保障部）中央就业政策",
  kind: "government_policy",
  entry_url: MOHRSS_POLICY_LIST_URL,
  access: "http",
  enabled: false,
  notes:
    "2026-11-21 真实试抓：www.mohrss.gov.cn 首页与各栏目页均返回 EdgeOne JS 混淆挑战（EO_Bot_Ssid），按 access_blocked 记录、不绕过；改用人社部主办的中国就业网 chinajob.mohrss.gov.cn 公开静态 HTML：列表 /zcfg/zxzc/zy/（中央）、详情 /c/YYYY-MM-DD/<id>.shtml，标题 .detail_con h4、来源 .detail_info .link、日期 .detail_info .date、正文 .detail_article。已存 1 列表 + 4 详情真实样本与离线回放用例；接线时由 lead 把 enabled 改为 true。",
};

export interface MohrssPolicyListItem {
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
}

export interface MohrssPolicyDetail {
  readonly sourceKey: string;
  readonly title: string;
  readonly url: string;
  readonly issuingAuthority: string | null;
  readonly sourceLabel: string | null;
  readonly bodyRaw: string;
  readonly publishedAt: string | null;
}

function toUtcDate(year: string, month: string, day: string): string | null {
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : iso;
}

/** 详情页 `2026.11.06` 与列表 URL 路径段 `2026-11-06` 共用同一转换规则，输出 UTC ISO。 */
export function parseMohrssPublishedDate(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const match = PAGE_DATE_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }
  return toUtcDate(match[1] ?? "", match[2] ?? "", match[3] ?? "");
}

export function parseMohrssPolicyList(html: string, listUrl: string): MohrssPolicyListItem[] {
  const doc = loadHtmlDocument(html, listUrl);
  const seen = new Set<string>();
  const items: MohrssPolicyListItem[] = [];
  for (const entry of doc.entries(".list_con_left > ul > li")) {
    const path = new URL(entry.href).pathname;
    const match = ITEM_PATH_PATTERN.exec(path);
    if (match === null) {
      continue;
    }
    if (seen.has(entry.href)) {
      continue;
    }
    seen.add(entry.href);
    items.push({
      title: entry.text,
      url: entry.href,
      publishedAt: toUtcDate(match[1] ?? "", match[2] ?? "", match[3] ?? ""),
    });
  }
  return items;
}

function cleanPageTitle(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const cut = value.indexOf(" - ");
  const title = (cut > 0 ? value.slice(0, cut) : value).trim();
  return title.length > 0 ? title : null;
}

function isValidIssuerCandidate(value: string): boolean {
  if (value.length < 2 || value.length > 60) {
    return false;
  }
  if (value.includes("《") || value.includes("》")) {
    return false;
  }
  return AGENCY_MARKER.test(value);
}

/**
 * 发文机关按以下顺序判定，全部失败返回 null（由调用方整批失败，不静默丢弃）：
 * 1. 标题中「关于」之前的机关前缀，如「人力资源社会保障部 财政部关于做好…的通知」；
 * 2. 标题以机关开头后接「修改/发布/印发」等动词，如「人力资源社会保障部修改发布《…》」；
 * 3. 部门规章正文开头的公布信息，如「（2026年5月10日人力资源社会保障部、…令第56号公布）」；
 * 4. 详情页「来源」字段（中国就业网转发时填发文机关）。
 */
export function resolveMohrssIssuer(
  title: string,
  sourceLabel: string | null,
  bodyRaw: string | null,
): string | null {
  const aboutIndex = title.indexOf("关于");
  if (aboutIndex > 0) {
    const prefix = title.slice(0, aboutIndex).trim();
    if (isValidIssuerCandidate(prefix)) {
      return prefix;
    }
  }

  const leading = LEADING_AGENCY_PATTERN.exec(title);
  if (leading !== null) {
    const prefix = (leading[1] ?? "").trim();
    if (isValidIssuerCandidate(prefix)) {
      return prefix;
    }
  }

  if (bodyRaw !== null) {
    const regulation = REGULATION_ISSUER_PATTERN.exec(bodyRaw.slice(0, 200));
    if (regulation !== null) {
      const prefix = (regulation[1] ?? "").trim();
      if (isValidIssuerCandidate(prefix)) {
        return prefix;
      }
    }
  }

  if (sourceLabel !== null) {
    const source = sourceLabel.trim();
    if (isValidIssuerCandidate(source)) {
      return source;
    }
  }
  return null;
}

export function parseMohrssPolicyDetail(
  html: string,
  url: string,
  fallbackPublishedAt: string | null = null,
): MohrssPolicyDetail {
  const doc = loadHtmlDocument(html, url);
  const heading = doc.normalizedText(".detail_con h4");
  const title = heading ?? cleanPageTitle(doc.normalizedText("title"));
  if (title === null) {
    throw new SchemaChangedError(`政策详情 ${url} 缺少标题`, MOHRSS_POLICY_SOURCE_KEY);
  }

  const body = doc.text(".detail_article");
  if (body === null || body.length < MIN_BODY_LENGTH) {
    throw new SchemaChangedError(`政策详情 ${url} 正文为空或过短`, MOHRSS_POLICY_SOURCE_KEY);
  }

  const sourceLabel = doc.normalizedText(".detail_info .link");
  return {
    sourceKey: MOHRSS_POLICY_SOURCE_KEY,
    title,
    url,
    issuingAuthority: resolveMohrssIssuer(title, sourceLabel, body),
    sourceLabel,
    bodyRaw: body,
    publishedAt:
      parseMohrssPublishedDate(doc.normalizedText(".detail_info .date")) ?? fallbackPublishedAt,
  };
}

function resolveThemeIds(detail: MohrssPolicyDetail): string[] {
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

export function toMohrssPolicyRef(detail: MohrssPolicyDetail): PolicyEvidenceRefV1 {
  const issuer = detail.issuingAuthority;
  if (issuer === null) {
    throw new ParseFailedError(`政策 ${detail.url} 缺少可判定的发文机关`, MOHRSS_POLICY_SOURCE_KEY);
  }
  const publishedAt = detail.publishedAt;
  if (publishedAt === null) {
    throw new ParseFailedError(`政策 ${detail.url} 缺少可解析的发布时间`, MOHRSS_POLICY_SOURCE_KEY);
  }
  return {
    policy_item_id: policyItemIdFromUrl(detail.url).replace(/\.shtml$/i, ""),
    title: detail.title,
    issuer,
    published_at: publishedAt.slice(0, 10),
    official_url: detail.url,
    source_tier: "government_official",
    theme_ids: resolveThemeIds(detail),
    evidence_excerpt: detail.bodyRaw.replace(/\s+/g, " ").slice(0, EXCERPT_LENGTH).trim(),
  };
}

export interface MohrssAdapterOptions {
  readonly itemLimit?: number;
  readonly pageLimit?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 接线后以 sources.ts 的登记定义（enabled 等）为准；未登记时用本文件的常量，便于先行离线验证。 */
function resolveMohrssDefinition(): CareerSourceDefinition {
  const registered = CAREER_SOURCE_DEFINITIONS.find(
    (item) => item.source_key === MOHRSS_POLICY_SOURCE_KEY,
  );
  return registered ?? MOHRSS_SOURCE_DEFINITION;
}

function buildRequest(url: string, signal: AbortSignal | undefined): PageRequest {
  return {
    url,
    method: "GET",
    headers: { accept: "text/html" },
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    sourceKey: MOHRSS_POLICY_SOURCE_KEY,
    ...(signal === undefined ? {} : { signal }),
  };
}

/** 列表分页地址：第 1 页是栏目首页，第 N 页为 index_N.shtml（中国就业网 zcms 约定）。 */
export function mohrssPolicyListPageUrl(page: number): string {
  return page === 1 ? MOHRSS_POLICY_LIST_URL : new URL(`index_${page}.shtml`, MOHRSS_POLICY_LIST_URL).toString();
}

export function createMohrssPolicyAdapter(
  transport: FetchTransport,
  options: MohrssAdapterOptions = {},
): PolicySourceAdapter {
  const definition = resolveMohrssDefinition();
  const itemLimit = Math.max(1, Math.min(options.itemLimit ?? 3, MAX_ITEMS));
  const pageLimit = Math.max(1, Math.min(options.pageLimit ?? 1, MAX_PAGES));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    definition,
    async collect(signal?: AbortSignal): Promise<PolicyEvidenceRefV1[]> {
      const seen = new Set<string>();
      const listItems: MohrssPolicyListItem[] = [];
      for (let page = 1; page <= pageLimit; page += 1) {
        if (signal?.aborted === true) {
          throw new DOMException("采集被取消", "AbortError");
        }
        if (page > 1) {
          await sleep(MIN_INTERVAL_MS);
        }
        const url = mohrssPolicyListPageUrl(page);
        const response = await transport.fetchPage(buildRequest(url, signal));
        const items = parseMohrssPolicyList(response.body.toString("utf8"), url);
        if (items.length === 0) {
          if (page === 1) {
            throw new EmptyResultError(`政策列表 ${url} 未解析出任何条目`, MOHRSS_POLICY_SOURCE_KEY);
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
        throw new EmptyResultError(`政策列表 ${MOHRSS_POLICY_LIST_URL} 未解析出任何条目`, MOHRSS_POLICY_SOURCE_KEY);
      }

      const out: PolicyEvidenceRefV1[] = [];
      const skipped: string[] = [];
      for (const item of targets) {
        if (signal?.aborted === true) {
          throw new DOMException("采集被取消", "AbortError");
        }
        await sleep(MIN_INTERVAL_MS);
        const response = await transport.fetchPage(buildRequest(item.url, signal));
        const draft = parseMohrssPolicyDetail(
          response.body.toString("utf8"),
          item.url,
          item.publishedAt,
        );
        try {
          out.push(toMohrssPolicyRef(draft));
        } catch (error) {
          skipped.push(`${item.url} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (skipped.length > 0) {
        throw new ParseFailedError(
          `政策解析失败 ${skipped.length}/${targets.length} 条，拒绝静默丢弃：${skipped.join("; ")}`,
          MOHRSS_POLICY_SOURCE_KEY,
        );
      }
      return out;
    },
  };
}
