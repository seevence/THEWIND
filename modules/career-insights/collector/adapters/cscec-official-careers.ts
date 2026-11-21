import type { RawCollectedJobV1 } from "../../contracts/index.ts";
import type {
  CareerCollectOptions,
  CareerSourceAdapter,
  CareerSourceDefinition,
} from "../index.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../sources.ts";
import { EmptyResultError, ParseFailedError, SchemaChangedError } from "../fetch/errors.ts";
import { createPageRequest } from "../fetch/transport.ts";
import type { FetchTransport, PageRequest } from "../fetch/transport.ts";
import { loadHtmlDocument } from "../html/parse.ts";
import { containsPersonalData } from "../evidence/sanitizer.ts";

/**
 * 中国建筑（www.cscec.com）社会招聘栏目。
 *
 * 2026-11-21 真实试抓：栏目页是公开静态 HTML，页内同时给出「集团总部招聘」与「所属企业招聘」两张列表，
 * 每条带发布日期和详情链接（2024 年以前的旧条目链接指向已下线的旧 CMS 路径，会返回 404，故只取最新条目）。
 * 详情页静态 HTML：标题 h2.gsywtpc、发布日期 .fbdate、正文 #gsxwxq 下的 <p> 段落；
 * 「一、二、招聘岗位」小节里逐条列出岗位（单位：岗位 / 岗位（N人）/ 单位小标题 + 岗位行）。
 * 无需 Cookie/Token/签名/验证码，同域请求间隔 >= 1s，列表 1 页 + 每个公告 1 个详情页。
 *
 * 公告正文按 sanitizer 规则检查：含个人联系方式（联系人/联系电话/简历投递:/邮箱/手机号）的公告整条跳过，
 * 不产出职位、不保存样本，避免把招聘联系人的 PII 带进公开数据；全部跳过时按空结果失败。
 */
export const CSCEC_COLLECTOR_VERSION = "collector/0.1.0";
export const CSCEC_LIST_URL = "https://www.cscec.com/rlzy_new/rczp/";
const SOURCE_KEY = "cscec-official-careers";
const PAGE_TIMEOUT_MS = 25_000;
const MIN_INTERVAL_MS = 1_000;
const DEFAULT_ITEM_LIMIT = 5;
const MAX_ITEM_LIMIT = 10;
const MIN_BODY_LENGTH = 20;
const CN_SECTION_NUMBER = "一二三四五六七八九十";

/**
 * 来源定义由 sources.ts 的 CAREER_SOURCE_DEFINITIONS 登记；接线前（本文件独立提交时）由 lead 把同一份
 * 定义合入 sources.ts，适配器优先使用登记定义，测试可经由 options.definition 注入。
 */
export const CSCEC_SOURCE_DEFINITION: CareerSourceDefinition = {
  source_key: SOURCE_KEY,
  label: "中国建筑社会招聘",
  kind: "company_careers",
  entry_url: CSCEC_LIST_URL,
  access: "http",
  enabled: true,
  notes:
    "2026-11-21 实测：公开静态 HTML（无 Cookie/Token/签名/验证码）——栏目页 /rlzy_new/rczp/ 同时列出「集团总部招聘」与「所属企业招聘」，每条带发布日期；详情页 /rlzy_new/rczp/{jtzbzp,ssqyzp}/YYYYMM/<id>.html，标题 h2.gsywtpc、发布日期 .fbdate、正文 #gsxwxq > p，招聘岗位小节逐条列出岗位。已存 1 份列表 + 5 份详情真实样本，适配器与回放用例通过。注意：2024 年以前条目的链接指向已下线的旧 CMS（/gbbf/shzp_new/…）会 404，适配器按发布日期取最新 N 条（默认 5、上限 10）；公告正文经 sanitizer 规则检查，含联系人/电话/邮箱的公告整条跳过（不落库不采样）。",
};

export interface CscecListItem {
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
}

export interface CscecPosition {
  /** 官方段落里的岗位名（去掉人数与「单位：」前缀后的原文）。 */
  readonly title: string;
  /** 官方人数写法，如 "2"、"若干"；未写为 null。 */
  readonly headcount: string | null;
  readonly unit: string | null;
  readonly locations: readonly string[];
  /** 该岗位在原文中的整段文字，便于人工核对。 */
  readonly sourceText: string;
}

export interface CscecAnnouncement {
  readonly announcementId: string;
  readonly url: string;
  readonly title: string;
  readonly companyName: string;
  readonly publishedAt: string;
  /** 正文按 <p> 段落拼接的官方文本（不含脚本/导航）。 */
  readonly body: string;
  /** 正文是否含个人联系方式（邮箱/手机号/联系人等），含则本公告整条跳过、不落库不采样。 */
  readonly bodyHasPersonalData: boolean;
  readonly positions: readonly CscecPosition[];
}

const SECTION_HEADING_PATTERN = new RegExp("^[" + CN_SECTION_NUMBER + "]+[、.．]\\s*招聘岗位");
const SECTION_BREAK_PATTERN = new RegExp("^[" + CN_SECTION_NUMBER + "]+[、.．]");
const NUMBERED_HEADING_PATTERN = /^\d{1,2}[.、．]\s*(.+)$/;
const WORK_LOCATION_PATTERN = /工作地点[：:]\s*([^（）()]+)/;
const UNIT_SUFFIX_PATTERN =
  /(?:公司|集团|总部|项目|分公司|部门|事业部|研究院|研究中心|中心|局|院|所|队|部)$/;
const COUNT_PATTERN = /(?:(\d{1,3})\s*[人名个]|若干(?:[人名个])?)/;
const TRAILING_CORNER_BRACKET_PATTERN = /[【\[]\s*[^【】\[\]]{1,60}\s*[】\]]\s*$/;
const TRAILING_ROUND_BRACKET_PATTERN = /[（(][^（）()]{1,40}[)）]\s*$/;
const ANNOUNCEMENT_SUFFIX_PATTERN = /(?:岗位)?(?:公开)?(?:社会)?(?:招聘|竞聘)(?:公告|简章|启事)$/;

function normalizeParagraph(value: string): string {
  return value.replace(/[\s\u3000]+/g, " ").trim();
}

function toUtcDate(year: string, month: string, day: string): string | null {
  const iso =
    year + "-" + month.padStart(2, "0") + "-" + day.padStart(2, "0") + "T00:00:00.000Z";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : iso;
}

/** 列表条目与详情页「发布日期：YYYY-MM-DD」共用解析规则；也接受「YYYY年M月D日」，无法解析返回 null。 */
export function parseCscecPublishedDate(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const dashed = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (dashed !== null) {
    return toUtcDate(dashed[1] ?? "", dashed[2] ?? "", dashed[3] ?? "");
  }
  const chinese = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(value);
  if (chinese !== null) {
    return toUtcDate(chinese[1] ?? "", chinese[2] ?? "", chinese[3] ?? "");
  }
  return null;
}

/**
 * 栏目页只有一页静态 HTML，两张列表（集团总部招聘 / 所属企业招聘）都在同一响应里。
 * 列表项结构为 li：span 日期 + a 标题。
 */
export function parseCscecList(html: string, listUrl: string): CscecListItem[] {
  const doc = loadHtmlDocument(html, listUrl);
  const seen = new Set<string>();
  const items: CscecListItem[] = [];
  for (const entry of doc.entries(".yxj-con ul.yxj-list > li")) {
    if (entry.text.length === 0 || seen.has(entry.href)) {
      continue;
    }
    seen.add(entry.href);
    items.push({
      title: entry.text,
      url: entry.href,
      publishedAt: parseCscecPublishedDate(entry.fullText),
    });
  }
  return items;
}

/** 由最新到最旧排序；缺发布日期排最后，同日保持页面顺序。 */
function compareNewestFirst(left: CscecListItem, right: CscecListItem): number {
  if (left.publishedAt === null && right.publishedAt === null) {
    return 0;
  }
  if (left.publishedAt === null) {
    return 1;
  }
  if (right.publishedAt === null) {
    return -1;
  }
  return right.publishedAt.localeCompare(left.publishedAt);
}

function extractLocations(value: string): string[] {
  const seen = new Set<string>();
  const match = WORK_LOCATION_PATTERN.exec(value);
  if (match === null) {
    return [];
  }
  for (const part of (match[1] ?? "").split(/[\/、,，]/)) {
    const name = part.trim();
    if (name.length > 0) {
      seen.add(name);
    }
  }
  return [...seen];
}

/** 「一、招聘岗位」小节里的小标题可能是单位（公司/项目/部门）或岗位类别（如「工程管理类」）。 */
function resolveSectionUnit(label: string): string | null {
  const value = label.trim();
  if (value.length === 0) {
    return null;
  }
  return UNIT_SUFFIX_PATTERN.test(value) ? value : null;
}

/** 把「单位：岗位」拆出单位；地点前缀不当单位，避免把「工作地点：北京」误判。 */
function splitUnitPrefix(value: string): { unit: string | null; rest: string } {
  const match = /^([^：:]{2,30})[：:]\s*(.+)$/.exec(value);
  if (match === null) {
    return { unit: null, rest: value };
  }
  const prefix = (match[1] ?? "").trim();
  if (WORK_LOCATION_PATTERN.test(prefix) || prefix.includes("工作地点")) {
    return { unit: null, rest: value };
  }
  return { unit: prefix, rest: (match[2] ?? "").trim() };
}

/** 去掉段落里的全部人数写法（含括号内的分地点人数），第一个命中作为 headcount。 */
function removeCount(value: string): { text: string; headcount: string | null } {
  const global = new RegExp(COUNT_PATTERN.source, "g");
  const matches = [...value.matchAll(global)];
  if (matches.length === 0) {
    return { text: value, headcount: null };
  }
  const headcount = matches[0]?.[1] ?? "若干";
  const withoutCount = value
    .replace(global, "")
    .replace(/[（(]\s*[，,、]+/g, "（")
    .replace(/[，,、]+\s*[）)]/g, "）")
    .replace(/[，,、]{2,}/g, "、");
  return { text: withoutCount, headcount };
}

function cleanPositionTitle(value: string): string {
  const cleaned = value
    .replace(/[（(]\s*[）)]/g, "")
    .replace(/^[（(]\s*/, "")
    .replace(/[）)\s]+$/, "")
    .replace(/[、，,；;。\s]+$/g, "")
    .replace(/^[、，,；;。\s]+/g, "")
    .trim();
  // 去掉人数后可能留下未闭合的括号（如「投融资岗（北京」），补上原文里对应的右括号。
  const openRound = (cleaned.match(/[（(]/g) ?? []).length;
  const closeRound = (cleaned.match(/[）)]/g) ?? []).length;
  if (openRound > closeRound) {
    return cleaned + "）";
  }
  return cleaned;
}

/**
 * 判断清洗后的文本是否像官方岗位名。公告里同段落常混着「基本条件」「详见附件」等说明文字，
 * 这里只保留 2–50 字、不含句读冒号的短标题；无法判定时宁可不产出，也不编造岗位。
 */
function isPositionTitle(value: string): boolean {
  if (value.length < 2 || value.length > 50) {
    return false;
  }
  // 括号内允许并列地名（如「商务岗（北京，深圳）」），括号外出现句读说明这不是岗位名。
  const withoutBrackets = value.replace(/[（(][^（）()]*[）)]/g, "");
  if (/[：:。；;，,、]/.test(withoutBrackets)) {
    return false;
  }
  if (/^(?:以下|详见|附件|备注|注|说明|基本条件|招聘条件|任职|要求)/.test(value)) {
    return false;
  }
  if (/详见|附件|招聘数量|招聘人数|岗位职责|任职资格/.test(value)) {
    return false;
  }
  if (/^\d/.test(value)) {
    return false;
  }
  if (SECTION_BREAK_PATTERN.test(value) || SECTION_HEADING_PATTERN.test(value)) {
    return false;
  }
  return true;
}

function toPosition(
  rawEntry: string,
  unit: string | null,
  locations: readonly string[],
): CscecPosition | null {
  const entry = rawEntry.trim().replace(/[、，,；;。\s]+$/g, "");
  if (entry.length === 0) {
    return null;
  }
  const prefixed = splitUnitPrefix(entry);
  const counted = removeCount(prefixed.rest);
  const title = cleanPositionTitle(counted.text);
  if (!isPositionTitle(title)) {
    return null;
  }
  return {
    title,
    headcount: counted.headcount,
    unit: prefixed.unit ?? unit,
    locations: [...locations],
    sourceText: entry,
  };
}

/** 一个段落里可能用「、/；」并列多个岗位（如「投融资岗2人（北京）、供金业务岗1人（北京）」）。 */
function splitPositionEntries(paragraph: string): string[] {
  const countMatches = [...paragraph.matchAll(new RegExp(COUNT_PATTERN.source, "g"))];
  // 只有一段里出现两个以上人数写法时才把中文逗号也当分隔符：单个岗位的说明文字可能带逗号。
  const separatorPattern = countMatches.length >= 2 ? /[、；;，,]/ : /[、；;]/;
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of paragraph) {
    if (char === "（" || char === "(" || char === "【" || char === "[") {
      depth += 1;
    } else if (char === "）" || char === ")" || char === "】" || char === "]") {
      depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && separatorPattern.test(char)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  const nonEmpty = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  if (nonEmpty.length <= 1) {
    return [paragraph];
  }
  return nonEmpty.map((part) => {
    const index = part.lastIndexOf("所属单位");
    return index >= 0 ? part.slice(index + "所属单位".length) : part;
  });
}

/**
 * 解析「招聘岗位」小节：返回逐条岗位。小节内的小标题（「1.中建中东公司总部（工作地点：…）」）
 * 用于给后续岗位补单位与工作地点；解析不出岗位时返回空数组，由调用方决定是否整批失败。
 */
export function parseCscecPositions(paragraphs: readonly string[]): CscecPosition[] {
  const normalized = paragraphs.map(normalizeParagraph);
  const start = normalized.findIndex((paragraph) => SECTION_HEADING_PATTERN.test(paragraph));
  if (start < 0) {
    return [];
  }
  let end = normalized.length;
  for (let index = start + 1; index < normalized.length; index += 1) {
    if (SECTION_BREAK_PATTERN.test(normalized[index] ?? "")) {
      end = index;
      break;
    }
  }

  const seen = new Set<string>();
  const positions: CscecPosition[] = [];
  let sectionUnit: string | null = null;
  let sectionLocations: readonly string[] = [];
  for (const paragraph of normalized.slice(start + 1, end)) {
    if (paragraph.length === 0) {
      continue;
    }
    const heading = NUMBERED_HEADING_PATTERN.exec(paragraph);
    // 「（工作地点：…）」小标题既可能是编号项也可能没有编号；带人数写法的段落按岗位处理。
    const isLocationHeading =
      WORK_LOCATION_PATTERN.test(paragraph) && COUNT_PATTERN.test(paragraph) === false;
    if (heading !== null || isLocationHeading) {
      const label = (heading !== null ? heading[1] ?? "" : paragraph).trim();
      sectionLocations = extractLocations(label);
      const labelWithoutLocation = label
        .replace(WORK_LOCATION_PATTERN, "")
        .replace(/[（(]\s*[）)]/g, "")
        .trim();
      sectionUnit = resolveSectionUnit(labelWithoutLocation);
      continue;
    }
    for (const entry of splitPositionEntries(paragraph)) {
      const position = toPosition(entry, sectionUnit, sectionLocations);
      if (position === null) {
        continue;
      }
      const identity = (position.unit ?? "") + "\u0000" + position.title;
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      positions.push(position);
    }
  }
  return positions;
}

/** 公告标题 → 招聘单位名：去掉尾部「（部门）」限定与「岗位招聘公告/招聘公告/公开竞聘公告」后缀。 */
export function resolveCscecCompanyName(title: string): string {
  let value = title.trim();
  // 先去掉尾部【…】/[…] 限定（可能内含圆括号，如【中国建筑（林芝）总部】），再去掉（…）限定。
  const withoutCorner = value.replace(TRAILING_CORNER_BRACKET_PATTERN, "").trim();
  if (withoutCorner.length > 0) {
    value = withoutCorner;
  }
  const withoutRound = value.replace(TRAILING_ROUND_BRACKET_PATTERN, "").trim();
  if (withoutRound.length > 0) {
    value = withoutRound;
  }
  value = value.replace(ANNOUNCEMENT_SUFFIX_PATTERN, "").trim();
  value = value.replace(/岗位$/, "").trim();
  return value.length >= 2 ? value : "中国建筑";
}

/** 详情链接末段数字即公告 ID（如 …/202611/3966090.html → 3966090）。 */
export function cscecAnnouncementIdFromUrl(url: string): string {
  const match = /(\d+)\.html?$/i.exec(new URL(url).pathname);
  if (match === null) {
    throw new ParseFailedError("中国建筑公告链接缺少数字 ID：" + url, SOURCE_KEY);
  }
  return match[1] ?? "";
}

export function parseCscecAnnouncement(
  html: string,
  url: string,
  fallbackPublishedAt: string | null = null,
): CscecAnnouncement {
  const doc = loadHtmlDocument(html, url);
  const title = doc.normalizedText("h2.gsywtpc");
  if (title === null) {
    throw new SchemaChangedError("中国建筑公告 " + url + " 缺少标题 h2.gsywtpc", SOURCE_KEY);
  }
  const paragraphs = doc
    .texts("#gsxwxq p")
    .map(normalizeParagraph)
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length === 0) {
    throw new SchemaChangedError("中国建筑公告 " + url + " 正文缺少段落", SOURCE_KEY);
  }
  const body = paragraphs.join("\n");
  if (body.length < MIN_BODY_LENGTH) {
    throw new SchemaChangedError("中国建筑公告 " + url + " 正文过短", SOURCE_KEY);
  }
  const publishedAt =
    parseCscecPublishedDate(doc.normalizedText(".fbdate")) ?? fallbackPublishedAt;
  if (publishedAt === null) {
    throw new SchemaChangedError("中国建筑公告 " + url + " 缺少可解析的发布日期", SOURCE_KEY);
  }
  return {
    announcementId: cscecAnnouncementIdFromUrl(url),
    url,
    title,
    companyName: resolveCscecCompanyName(title),
    publishedAt,
    body,
    bodyHasPersonalData: containsPersonalData(body),
    positions: parseCscecPositions(paragraphs),
  };
}

/**
 * 一条公告里的每个岗位产出一条 RawCollectedJobV1：source_job_id 用「公告 ID:岗位序号」，
 * raw_text 保留公告正文原文（含该单位的招聘条件/程序），official_url 指向公告详情页。
 */
export function toCscecRawJobs(
  announcement: CscecAnnouncement,
  fetchedAt: string,
): RawCollectedJobV1[] {
  if (announcement.bodyHasPersonalData) {
    throw new ParseFailedError(
      "中国建筑公告 " + announcement.url + " 正文含个人联系方式，按 sanitizer 规则拒收",
      SOURCE_KEY,
    );
  }
  return announcement.positions.map((position, index) => ({
    schema_version: "1.0",
    source_key: SOURCE_KEY,
    source_job_id: announcement.announcementId + ":" + String(index + 1),
    company_name: announcement.companyName,
    title: position.title,
    official_url: announcement.url,
    raw_text: announcement.body,
    published_at: announcement.publishedAt,
    fetched_at: fetchedAt,
    collector_version: CSCEC_COLLECTOR_VERSION,
    hints: {
      role_family: "unknown",
      locations: [...position.locations],
      degree_raw: null,
      experience_raw: null,
      employment_type: "experienced",
      skill_terms: [],
    },
  }));
}

export interface CscecAdapterOptions {
  /** 单次采集最多处理的公告数（按发布日期从新到旧），默认 5，上限 10。 */
  readonly itemLimit?: number;
  readonly definition?: CareerSourceDefinition;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => string;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function buildListRequest(sourceKey: string, signal: AbortSignal | undefined): PageRequest {
  return createPageRequest({
    url: CSCEC_LIST_URL,
    sourceKey,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9",
    },
    ...(signal === undefined ? {} : { signal }),
  });
}

function buildDetailRequest(
  url: string,
  sourceKey: string,
  signal: AbortSignal | undefined,
): PageRequest {
  return createPageRequest({
    url,
    sourceKey,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9",
      referer: CSCEC_LIST_URL,
    },
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createCscecOfficialCareersAdapter(
  transport: FetchTransport,
  options: CscecAdapterOptions = {},
): CareerSourceAdapter {
  const definition =
    options.definition ??
    CAREER_SOURCE_DEFINITIONS.find((item) => item.source_key === SOURCE_KEY) ??
    CSCEC_SOURCE_DEFINITION;
  const itemLimit = Math.max(1, Math.min(options.itemLimit ?? DEFAULT_ITEM_LIMIT, MAX_ITEM_LIMIT));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date().toISOString());

  return {
    definition,
    async collect(
      signal?: AbortSignal,
      _callOptions?: CareerCollectOptions,
    ): Promise<RawCollectedJobV1[]> {
      if (isAborted(signal)) {
        throw new DOMException("采集被取消", "AbortError");
      }
      const listResponse = await transport.fetchPage(
        buildListRequest(definition.source_key, signal),
      );
      const listItems = parseCscecList(listResponse.body.toString("utf8"), listResponse.finalUrl);
      if (listItems.length === 0) {
        throw new EmptyResultError(
          "中国建筑招聘栏目 " + CSCEC_LIST_URL + " 未解析出任何公告",
          SOURCE_KEY,
        );
      }

      const targets = [...listItems].sort(compareNewestFirst).slice(0, itemLimit);
      const jobs: RawCollectedJobV1[] = [];
      let skippedPersonalData = 0;
      for (const item of targets) {
        if (isAborted(signal)) {
          throw new DOMException("采集被取消", "AbortError");
        }
        await sleep(MIN_INTERVAL_MS);
        const detailResponse = await transport.fetchPage(
          buildDetailRequest(item.url, definition.source_key, signal),
        );
        const announcement = parseCscecAnnouncement(
          detailResponse.body.toString("utf8"),
          item.url,
          item.publishedAt,
        );
        // 公告正文含招聘联系人 PII 时整条跳过：公开数据与样本都不能带联系方式。
        if (announcement.bodyHasPersonalData) {
          skippedPersonalData += 1;
          continue;
        }
        jobs.push(...toCscecRawJobs(announcement, now()));
      }

      if (jobs.length === 0) {
        throw new EmptyResultError(
          "中国建筑最新公告均未解析出岗位（含个人联系方式而跳过的公告：" +
            skippedPersonalData +
            " 条）",
          SOURCE_KEY,
        );
      }
      return jobs;
    },
  };
}
