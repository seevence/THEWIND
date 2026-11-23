import type { PolicyEvidenceRefV1 } from "../../contracts/index.ts";
import type { CareerSourceDefinition } from "../index.ts";

import { EmptyResultError, ParseFailedError } from "../fetch/errors.ts";
import type { FetchTransport, PageRequest } from "../fetch/transport.ts";
import { loadHtmlDocument } from "../html/parse.ts";
import type { HtmlDocument } from "../html/parse.ts";
import { THEME_KEYWORDS } from "../../data/dictionaries.ts";
import { policyItemIdFromUrl } from "./policy-id.ts";
import type { PolicyDetailDraft } from "./policy-parse.ts";
import type { PolicySourceAdapter } from "./policy-sources.ts";

/**
 * 湖南省人力资源和社会保障厅「通知公告」栏目（就业、培训、社保、人才）。
 *
 * 列表页只有「通知公告」内容容器内的条目才是政策：
 * .zfxxgk-content > .xxgkzd-box > .box > ul > li，链接形如
 * /rst/xxgk/tzgg/YYYYMM/tYYYYMMDD_<id>.html，同项 <span>YYYY-MM-DD</span>。
 * 页面其余 <li> 是站点导航与政务公开栏目，按路径白名单排除。
 * 详情页 h1.articletitle 标题、div.articleCont（#j-show-body）正文、div.pinfo 的
 * 「发布时间：YYYY-MM-DD」。无 Cookie/Token/签名/验证码；列表页为 http 明文
 * （源站 index.html 走 302，站点其他页面同为 http），同域请求间隔 >= 1s。
 */
export const HUNAN_RSJ_SOURCE_KEY = "hunan-rsj-policy";
export const HUNAN_RSJ_LIST_URL = "http://rst.hunan.gov.cn/rst/xxgk/tzgg/index.html";
export const HUNAN_RSJ_ISSUER = "湖南省人力资源和社会保障厅";

const PAGE_TIMEOUT_MS = 25_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_ITEMS = 10;
const EXCERPT_LENGTH = 200;
const MAX_THEMES = 3;
const LIST_DATE_PATTERN = /(\d{4})-(\d{1,2})-(\d{1,2})/g;
const PAGE_DATE_PATTERN = /发布时间[:：]\s*(\d{4})-(\d{1,2})-(\d{1,2})/;
/** 「通知公告」内容容器：只在这里找条目，不扫全文档的导航 <li>。 */
const LIST_CONTAINER_SELECTOR = ".xxgkzd-box .box ul > li";
/** 详情正文容器：整容器文本，正文主体可能落在 span/font 里而不是 <p> 里。 */
const BODY_CONTAINER_SELECTOR = "div.articleCont";
const BODY_CONTAINER_FALLBACK_SELECTOR = "#j-show-body";
/** 块级边界：按这些标签把容器内 HTML 切成段落，保留文档顺序。 */
const BLOCK_BOUNDARY_PATTERN = /<\/?(?:p|div|li|h[1-6]|br)\b[^>]*>/gi;
/** 本栏目政策详情路径；栏目外的链接（政务公开、导航）一律不算条目。 */
const ARTICLE_PATH_PATTERN = /^\/rst\/xxgk\/tzgg\/\d{6}\/t\d{8}_\d+\.html$/;

export const HUNAN_RSJ_SOURCE_DEFINITION: CareerSourceDefinition = {
  source_key: HUNAN_RSJ_SOURCE_KEY,
  label: "湖南省人力资源和社会保障厅通知公告",
  kind: "government_policy",
  entry_url: HUNAN_RSJ_LIST_URL,
  access: "http",
  enabled: true,
  notes:
    "静态 HTML：列表 http://rst.hunan.gov.cn/rst/xxgk/tzgg/index.html（源站 index.html 走 302，列表与详情均为 http 明文）；只解析「通知公告」容器 .xxgkzd-box .box ul > li，且链接路径须匹配 /rst/xxgk/tzgg/YYYYMM/tYYYYMMDD_<id>.html（/rst/xxgk/tzgg/\\d{6}/t\\d{8}_\\d+\\.html），导航与政务公开栏目按白名单排除；条目无日期即丢弃。详情标题 h1.articletitle、正文取 div.articleCont（#j-show-body）整个容器并按块级元素（p/div/li/h1–h6/br）分段、发布时间 div.pinfo。无 Cookie/Token/签名/验证码，同域请求间隔 >= 1s。",
};

export interface HunanRsjListItem {
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
}

function toUtcDate(year: string, month: string, day: string): string | null {
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : iso;
}

/** 列表项日期在标题链接之后（<a>标题</a><span>2026-11-20</span>），取同项最后一个 YYYY-MM-DD。 */
function parseListDate(fullText: string): string | null {
  const matches = [...fullText.matchAll(LIST_DATE_PATTERN)];
  const last = matches.at(-1);
  if (last === undefined) {
    return null;
  }
  return toUtcDate(last[1] ?? "", last[2] ?? "", last[3] ?? "");
}

function parsePageDate(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const match = PAGE_DATE_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  return toUtcDate(match[1] ?? "", match[2] ?? "", match[3] ?? "");
}

function isArticleUrl(href: string): boolean {
  try {
    return ARTICLE_PATH_PATTERN.test(new URL(href).pathname);
  } catch {
    return false;
  }
}

const ENTITY_MAP: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const point = Number.parseInt(code.slice(2), 16);
      return Number.isNaN(point) ? match : String.fromCodePoint(point);
    }
    if (code.startsWith("#")) {
      const point = Number.parseInt(code.slice(1), 10);
      return Number.isNaN(point) ? match : String.fromCodePoint(point);
    }
    return ENTITY_MAP[code.toLowerCase()] ?? match;
  });
}

/** 单个块级片段的文本：去标签、解实体、折叠空白；纯空白片段丢弃。 */
function toBlockText(chunk: string): string {
  return decodeEntities(chunk.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 正文取整容器的文本，按块级元素（p/div/li/h1–h6/br）切分并保留段落顺序。
 * 真实页面正文主体常直接放在容器下的 span/font 里（不在 <p> 内），因此不得只取 <p> 子集。
 */
function parseBodyRaw(doc: HtmlDocument): string {
  const inner =
    doc.html(BODY_CONTAINER_SELECTOR) ?? doc.html(BODY_CONTAINER_FALLBACK_SELECTOR) ?? "";
  const cleaned = inner
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  return cleaned
    .split(BLOCK_BOUNDARY_PATTERN)
    .map(toBlockText)
    .filter((block) => block.length > 0)
    .join("\n");
}

/** 摘录取正文首段（压缩空白后前 200 字），保证不落在联系方式段落上。 */
function excerptFrom(bodyRaw: string): string {
  const first = bodyRaw.split("\n")[0] ?? "";
  return first.replace(/\s+/g, " ").slice(0, EXCERPT_LENGTH).trim();
}

export function parseHunanRsjList(html: string, baseUrl: string): HunanRsjListItem[] {
  const doc = loadHtmlDocument(html, baseUrl);
  const seen = new Set<string>();
  const items: HunanRsjListItem[] = [];
  for (const entry of doc.entries(LIST_CONTAINER_SELECTOR)) {
    if (!isArticleUrl(entry.href) || seen.has(entry.href)) {
      continue;
    }
    const publishedAt = parseListDate(entry.fullText);
    if (publishedAt === null) {
      continue;
    }
    seen.add(entry.href);
    items.push({
      title: entry.text,
      url: entry.href,
      publishedAt,
    });
  }
  return items;
}

/**
 * 标题或正文为空时返回空字符串而不抛错：采集侧把这类条目计入 skipped，
 * 同批尚有成功条目时照常返回，全部失败才由 ParseFailedError 汇总抛出（不静默丢弃）。
 */
export function parseHunanRsjDetail(
  html: string,
  url: string,
  fallbackPublishedAt: string | null = null,
): PolicyDetailDraft {
  const doc = loadHtmlDocument(html, url);
  return {
    sourceKey: HUNAN_RSJ_SOURCE_KEY,
    title: doc.normalizedText("h1.articletitle") ?? "",
    url,
    issuingAuthority: HUNAN_RSJ_ISSUER,
    documentNumber: null,
    bodyRaw: parseBodyRaw(doc),
    publishedAt: parsePageDate(doc.normalizedText("div.pinfo")) ?? fallbackPublishedAt,
  };
}

function resolveThemes(draft: PolicyDetailDraft): string[] {
  const haystack = `${draft.title}\n${draft.bodyRaw}`.toLowerCase();
  const themes: string[] = [];
  for (const [themeId, keywords] of Object.entries(THEME_KEYWORDS)) {
    if (themes.length >= MAX_THEMES) break;
    if (keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
      themes.push(themeId);
    }
  }
  return themes;
}

function toPolicyRef(draft: PolicyDetailDraft): PolicyEvidenceRefV1 {
  if (draft.publishedAt === null) {
    throw new ParseFailedError(`政策 ${draft.url} 缺少可解析的发布时间`, HUNAN_RSJ_SOURCE_KEY);
  }
  return {
    policy_item_id: policyItemIdFromUrl(draft.url),
    title: draft.title,
    issuer: HUNAN_RSJ_ISSUER,
    published_at: draft.publishedAt.slice(0, 10),
    official_url: draft.url,
    source_tier: "government_official",
    theme_ids: resolveThemes(draft),
    evidence_excerpt: excerptFrom(draft.bodyRaw),
  };
}

export interface HunanRsjAdapterOptions {
  readonly itemLimit?: number;
  readonly definition?: CareerSourceDefinition;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** sources.ts 引用本文件的常量登记；接线时由调用方显式传入登记定义。 */
function resolveDefinition(explicit: CareerSourceDefinition | undefined): CareerSourceDefinition {
  return explicit ?? HUNAN_RSJ_SOURCE_DEFINITION;
}

function buildRequest(url: string, signal: AbortSignal | undefined): PageRequest {
  return {
    url,
    method: "GET",
    headers: { accept: "text/html" },
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    sourceKey: HUNAN_RSJ_SOURCE_KEY,
    ...(signal === undefined ? {} : { signal }),
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("采集被取消", "AbortError");
  }
}

export function createHunanRsjPolicyAdapter(
  transport: FetchTransport,
  options: HunanRsjAdapterOptions = {},
): PolicySourceAdapter {
  const definition = resolveDefinition(options.definition);
  const itemLimit = Math.max(1, Math.min(options.itemLimit ?? 3, MAX_ITEMS));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    definition,
    async collect(signal?: AbortSignal): Promise<PolicyEvidenceRefV1[]> {
      assertNotAborted(signal);
      const listResponse = await transport.fetchPage(buildRequest(HUNAN_RSJ_LIST_URL, signal));
      const items = parseHunanRsjList(
        listResponse.body.toString("utf8"),
        HUNAN_RSJ_LIST_URL,
      ).slice(0, itemLimit);
      if (items.length === 0) {
        throw new EmptyResultError(
          `政策列表 ${HUNAN_RSJ_LIST_URL} 未解析出任何条目`,
          HUNAN_RSJ_SOURCE_KEY,
        );
      }

      const out: PolicyEvidenceRefV1[] = [];
      const skipped: string[] = [];
      for (const item of items) {
        assertNotAborted(signal);
        await sleep(MIN_INTERVAL_MS);
        const detailResponse = await transport.fetchPage(buildRequest(item.url, signal));
        const draft = parseHunanRsjDetail(
          detailResponse.body.toString("utf8"),
          item.url,
          item.publishedAt,
        );
        if (draft.title.length === 0 || draft.bodyRaw.length === 0) {
          skipped.push(`${item.url} 详情标题或正文为空`);
          continue;
        }
        try {
          out.push(toPolicyRef(draft));
        } catch (error) {
          skipped.push(`${item.url} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (out.length === 0 && skipped.length > 0) {
        throw new ParseFailedError(
          `政策解析失败 ${skipped.length}/${items.length} 条，0 条产出，拒绝静默丢弃：${skipped.slice(0, 3).join("; ")}`,
          HUNAN_RSJ_SOURCE_KEY,
        );
      }
      return out;
    },
  };
}