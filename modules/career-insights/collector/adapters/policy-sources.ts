import type { PolicyEvidenceRefV1 } from "../../contracts/index.ts";
import type { CareerSourceDefinition } from "../index.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../sources.ts";
import { ConfigError, EmptyResultError, ParseFailedError } from "../fetch/errors.ts";
import type { FetchTransport, PageRequest } from "../fetch/transport.ts";
import {
  MOE_POLICY_LIST_URL,
  parseGovPolicyDetail,
  parseGovPolicyList,
  parseMoePolicyDetail,
  parseMoePolicyList,
  parseNdrcPolicyDetail,
  parseNdrcPolicyList,
} from "./policy-parse.ts";
import type { PolicyDetailDraft } from "./policy-parse.ts";
import { policyItemIdFromUrl } from "./policy-id.ts";
import { THEME_KEYWORDS } from "../../data/dictionaries.ts";

const GOV_SOURCE_KEY = "state-council-policy";
const NDRC_SOURCE_KEY = "ndrc-policy";
const MOE_SOURCE_KEY = "moe-policy";
const PAGE_TIMEOUT_MS = 25_000;
const MIN_INTERVAL_MS = 1_000;
const EXCERPT_LENGTH = 200;
const MAX_THEMES = 3;

export const GOV_POLICY_LIST_URL = "https://www.gov.cn/zhengce/index.htm";
export const NDRC_POLICY_LIST_URL = "https://www.ndrc.gov.cn/xxgk/zcfb/tz/";
export { MOE_POLICY_LIST_URL };

export interface PolicySourceAdapter {
  readonly definition: CareerSourceDefinition;
  collect(signal?: AbortSignal): Promise<PolicyEvidenceRefV1[]>;
}

export interface PolicyAdapterOptions {
  readonly itemLimit?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function resolveDefinition(sourceKey: string): CareerSourceDefinition {
  const definition = CAREER_SOURCE_DEFINITIONS.find((item) => item.source_key === sourceKey);
  if (definition === undefined) {
    throw new ConfigError(`来源 ${sourceKey} 未在 CAREER_SOURCE_DEFINITIONS 中登记`);
  }
  return definition;
}

function buildRequest(url: string, sourceKey: string, signal: AbortSignal | undefined): PageRequest {
  return {
    url,
    method: "GET",
    headers: { accept: "text/html" },
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    sourceKey,
    ...(signal === undefined ? {} : { signal }),
  };
}


function throwIfSkipped(sourceKey: string, total: number, skipped: readonly string[]): void {
  if (skipped.length === 0) {
    return;
  }
  throw new ParseFailedError(
    `政策解析失败 ${skipped.length}/${total} 条，拒绝静默丢弃：${skipped.join("; ")}`,
    sourceKey,
  );
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

function resolveGovIssuer(draft: PolicyDetailDraft): string | null {
  const head = `${draft.title}\n${draft.bodyRaw.slice(0, 300)}`;
  if (head.includes("中共中央")) return "中共中央";
  if (head.includes("国务院办公厅")) return "国务院办公厅";
  if (head.includes("中华人民共和国国务院令") || head.includes("国务院")) return "国务院";
  return null;
}

function isoDate(value: string | null): string | null {
  if (value === null) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(value);
  return match?.[1] ?? null;
}

function toPolicyRef(draft: PolicyDetailDraft, issuer: string, sourceTier: string): PolicyEvidenceRefV1 {
  const publishedAt = isoDate(draft.publishedAt);
  if (publishedAt === null) {
    throw new ParseFailedError(`政策 ${draft.url} 缺少可解析的发布时间`, draft.sourceKey);
  }
  return {
    policy_item_id: policyItemIdFromUrl(draft.url),
    title: draft.title,
    issuer,
    published_at: publishedAt,
    official_url: draft.url,
    source_tier: sourceTier,
    theme_ids: resolveThemes(draft),
    evidence_excerpt: draft.bodyRaw.replace(/\s+/g, " ").slice(0, EXCERPT_LENGTH).trim(),
  };
}

export function createGovPolicySourceAdapter(
  transport: FetchTransport,
  options: PolicyAdapterOptions = {},
): PolicySourceAdapter {
  const definition = resolveDefinition(GOV_SOURCE_KEY);
  const itemLimit = Math.max(1, Math.min(options.itemLimit ?? 3, 10));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    definition,
    async collect(signal?: AbortSignal): Promise<PolicyEvidenceRefV1[]> {
      const listResponse = await transport.fetchPage(
        buildRequest(GOV_POLICY_LIST_URL, GOV_SOURCE_KEY, signal),
      );
      const items = parseGovPolicyList(listResponse.body.toString("utf8"), GOV_POLICY_LIST_URL).slice(
        0,
        itemLimit,
      );
      if (items.length === 0) {
        throw new EmptyResultError(`政策列表 ${GOV_POLICY_LIST_URL} 未解析出任何条目`, GOV_SOURCE_KEY);
      }

      const out: PolicyEvidenceRefV1[] = [];
      const skipped: string[] = [];
      for (const item of items) {
        if (signal?.aborted === true) {
          throw new DOMException("采集被取消", "AbortError");
        }
        await sleep(MIN_INTERVAL_MS);
        const detailResponse = await transport.fetchPage(
          buildRequest(item.url, GOV_SOURCE_KEY, signal),
        );
        const draft = parseGovPolicyDetail(
          detailResponse.body.toString("utf8"),
          item.url,
          item.publishedAt,
        );
        const issuer = resolveGovIssuer(draft);
        if (issuer === null) {
          skipped.push(`${item.url} issuer 无法判定`);
          continue;
        }
        try {
          out.push(toPolicyRef(draft, issuer, "government_official"));
        } catch (error) {
          skipped.push(`${item.url} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throwIfSkipped(GOV_SOURCE_KEY, items.length, skipped);
      return out;
    },
  };
}

export function createNdrcPolicySourceAdapter(
  transport: FetchTransport,
  options: PolicyAdapterOptions = {},
): PolicySourceAdapter {
  const definition = resolveDefinition(NDRC_SOURCE_KEY);
  const itemLimit = Math.max(1, Math.min(options.itemLimit ?? 3, 10));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    definition,
    async collect(signal?: AbortSignal): Promise<PolicyEvidenceRefV1[]> {
      const listResponse = await transport.fetchPage(
        buildRequest(NDRC_POLICY_LIST_URL, NDRC_SOURCE_KEY, signal),
      );
      const items = parseNdrcPolicyList(listResponse.body.toString("utf8"), NDRC_POLICY_LIST_URL).slice(
        0,
        itemLimit,
      );
      if (items.length === 0) {
        throw new EmptyResultError(`政策列表 ${NDRC_POLICY_LIST_URL} 未解析出任何条目`, NDRC_SOURCE_KEY);
      }

      const out: PolicyEvidenceRefV1[] = [];
      const skipped: string[] = [];
      for (const item of items) {
        if (signal?.aborted === true) {
          throw new DOMException("采集被取消", "AbortError");
        }
        await sleep(MIN_INTERVAL_MS);
        const detailResponse = await transport.fetchPage(
          buildRequest(item.url, NDRC_SOURCE_KEY, signal),
        );
        const draft = parseNdrcPolicyDetail(
          detailResponse.body.toString("utf8"),
          item.url,
          item.publishedAt,
        );
        try {
          out.push(toPolicyRef(draft, "国家发展改革委", "government_official"));
        } catch (error) {
          skipped.push(`${item.url} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throwIfSkipped(NDRC_SOURCE_KEY, items.length, skipped);
      return out;
    },
  };
}
export function createMoePolicySourceAdapter(
  transport: FetchTransport,
  options: PolicyAdapterOptions = {},
): PolicySourceAdapter {
  const definition = resolveDefinition(MOE_SOURCE_KEY);
  const itemLimit = Math.max(1, Math.min(options.itemLimit ?? 3, 10));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    definition,
    async collect(signal?: AbortSignal): Promise<PolicyEvidenceRefV1[]> {
      const listResponse = await transport.fetchPage(
        buildRequest(MOE_POLICY_LIST_URL, MOE_SOURCE_KEY, signal),
      );
      const items = parseMoePolicyList(
        listResponse.body.toString("utf8"),
        MOE_POLICY_LIST_URL,
      ).slice(0, itemLimit);
      if (items.length === 0) {
        throw new EmptyResultError(`政策列表 ${MOE_POLICY_LIST_URL} 未解析出任何条目`, MOE_SOURCE_KEY);
      }

      const out: PolicyEvidenceRefV1[] = [];
      const skipped: string[] = [];
      for (const item of items) {
        if (signal?.aborted === true) {
          throw new DOMException("采集被取消", "AbortError");
        }
        await sleep(MIN_INTERVAL_MS);
        const detailResponse = await transport.fetchPage(
          buildRequest(item.url, MOE_SOURCE_KEY, signal),
        );
        const draft = parseMoePolicyDetail(
          detailResponse.body.toString("utf8"),
          item.url,
          item.publishedAt,
        );
        try {
          out.push(toPolicyRef(draft, "教育部", "government_official"));
        } catch (error) {
          skipped.push(`${item.url} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throwIfSkipped(MOE_SOURCE_KEY, items.length, skipped);
      return out;
    },
  };
}