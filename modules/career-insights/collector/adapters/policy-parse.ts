import { SchemaChangedError } from "../fetch/errors.ts";
import { loadHtmlDocument } from "../html/parse.ts";

const GOV_SOURCE_KEY = "state-council-policy";
const NDRC_SOURCE_KEY = "ndrc-policy";
const MIN_BODY_LENGTH = 20;

export interface PolicyListItem {
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
}

export interface PolicyDetailDraft {
  readonly sourceKey: string;
  readonly title: string;
  readonly url: string;
  readonly issuingAuthority: string | null;
  readonly documentNumber: string | null;
  readonly bodyRaw: string;
  readonly publishedAt: string | null;
}

function toUtcDate(year: string, month: string, day: string): string | null {
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : iso;
}

function parseSlashDate(value: string | null): string | null {
  if (value === null) return null;
  const match = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(value);
  return match === null ? null : toUtcDate(match[1] ?? "", match[2] ?? "", match[3] ?? "");
}

function parseDashDate(value: string | null): string | null {
  if (value === null) return null;
  const match = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  return match === null ? null : toUtcDate(match[1] ?? "", match[2] ?? "", match[3] ?? "");
}

function documentNumberFrom(text: string | null): string | null {
  if (text === null) return null;
  const match = /([\u4e00-\u9fa5]{2,10}〔\d{4}〕\d+号)/.exec(text);
  return match?.[1] ?? null;
}

export function parseGovPolicyList(html: string, listUrl: string): PolicyListItem[] {
  const doc = loadHtmlDocument(html, listUrl);
  return doc
    .entries("li")
    .filter(
      (entry) =>
        entry.href.includes("www.gov.cn/zhengce/") &&
        entry.href !== listUrl &&
        entry.text.length >= 8,
    )
    .map((entry) => ({
      title: entry.text,
      url: entry.href,
      publishedAt: parseDashDate(entry.fullText),
    }));
}

export function parseGovPolicyDetail(
  html: string,
  url: string,
  fallbackPublishedAt: string | null = null,
): PolicyDetailDraft {
  const doc = loadHtmlDocument(html, url);
  const heading = doc.normalizedText("h1");
  const pageTitle = doc.normalizedText("title");
  const title = heading ?? cleanSiteSuffix(pageTitle, "_中国政府网");
  if (title === null) {
    throw new SchemaChangedError(`政策详情 ${url} 缺少标题`, GOV_SOURCE_KEY);
  }

  const body = doc.text("#UCAP-CONTENT") ?? doc.text(".pages_content") ?? doc.text(".article");
  if (body === null || body.length < MIN_BODY_LENGTH) {
    throw new SchemaChangedError(`政策详情 ${url} 正文为空或过短`, GOV_SOURCE_KEY);
  }

  const articleText = doc.normalizedText(".article");
  return {
    sourceKey: GOV_SOURCE_KEY,
    title,
    url,
    issuingAuthority: null,
    documentNumber: documentNumberFrom(body.slice(0, 200)),
    bodyRaw: body,
    publishedAt:
      parseDashDate(articleText) ??
      parseDashDate(doc.attr('meta[name="publishdate"]', "content")) ??
      fallbackPublishedAt,
  };
}

export function parseNdrcPolicyList(html: string, listUrl: string): PolicyListItem[] {
  const doc = loadHtmlDocument(html, listUrl);
  return doc
    .entries("li")
    .filter(
      (entry) =>
        entry.href.includes("/xxgk/zcfb/tz/") &&
        entry.href !== listUrl &&
        entry.text.length >= 8,
    )
    .map((entry) => ({
      title: entry.text,
      url: entry.href,
      publishedAt: parseSlashDate(entry.fullText),
    }));
}

export function parseNdrcPolicyDetail(
  html: string,
  url: string,
  fallbackPublishedAt: string | null = null,
): PolicyDetailDraft {
  const doc = loadHtmlDocument(html, url);
  const pageTitle = doc.normalizedText("title");
  const title = cleanBracketTitle(pageTitle);
  if (title === null) {
    throw new SchemaChangedError(`政策详情 ${url} 缺少标题`, NDRC_SOURCE_KEY);
  }

  const body = doc.text(".TRS_Editor") ?? doc.text(".article_con") ?? doc.text(".article");
  if (body === null || body.length < MIN_BODY_LENGTH) {
    throw new SchemaChangedError(`政策详情 ${url} 正文为空或过短`, NDRC_SOURCE_KEY);
  }

  const timeText = doc.normalizedText(".time");
  return {
    sourceKey: NDRC_SOURCE_KEY,
    title,
    url,
    issuingAuthority: null,
    documentNumber: documentNumberFrom(title),
    bodyRaw: body,
    publishedAt: parseSlashDate(timeText) ?? fallbackPublishedAt,
  };
}

function cleanSiteSuffix(value: string | null, suffix: string): string | null {
  if (value === null) return null;
  const index = value.indexOf(suffix);
  const withoutSite = index < 0 ? value : value.slice(0, index);
  const withoutSection = withoutSite.split("_")[0]?.trim() ?? "";
  return withoutSection.length > 0 ? withoutSection : null;
}

function cleanBracketTitle(value: string | null): string | null {
  if (value === null) return null;
  const bracketed = /^【(.+?)】/.exec(value);
  if (bracketed !== null) {
    return bracketed[1]?.trim() ?? null;
  }
  const cut = value.indexOf("-国家发展和改革委员会");
  return cut > 0 ? value.slice(0, cut).trim() : value;
}
const MOE_SOURCE_KEY = "moe-policy";

export const MOE_POLICY_LIST_URL = "https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/";

export function parseMoePolicyList(html: string, listUrl: string): PolicyListItem[] {
  const doc = loadHtmlDocument(html, listUrl);
  return doc
    .entries("li")
    .filter(
      (entry) =>
        entry.href.includes("/s5743/s5744/") &&
        entry.href !== listUrl &&
        entry.text.length >= 8,
    )
    .map((entry) => ({
      title: entry.text,
      url: entry.href,
      publishedAt: parseDashDate(entry.fullText),
    }));
}

export function parseMoePolicyDetail(
  html: string,
  url: string,
  fallbackPublishedAt: string | null = null,
): PolicyDetailDraft {
  const doc = loadHtmlDocument(html, url);
  const title = doc.normalizedText("h1") ?? cleanMoeTitle(doc.normalizedText("title"));
  if (title === null) {
    throw new SchemaChangedError(`政策详情 ${url} 缺少标题`, MOE_SOURCE_KEY);
  }

  const body = doc.text(".TRS_Editor") ?? doc.text(".moe-detail-box");
  if (body === null || body.length < MIN_BODY_LENGTH) {
    throw new SchemaChangedError(`政策详情 ${url} 正文为空或过短`, MOE_SOURCE_KEY);
  }

  return {
    sourceKey: MOE_SOURCE_KEY,
    title,
    url,
    issuingAuthority: null,
    documentNumber: documentNumberFrom(body.slice(0, 200)),
    bodyRaw: body,
    publishedAt:
      parseDashDate(doc.attr('meta[name="publishdate"]', "content")) ?? fallbackPublishedAt,
  };
}

function cleanMoeTitle(value: string | null): string | null {
  if (value === null) return null;
  const cut = value.indexOf(" - ");
  const title = (cut > 0 ? value.slice(0, cut) : value).trim();
  return title.length > 0 ? title : null;
}