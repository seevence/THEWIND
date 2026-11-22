import { beijingAt } from "@aihot/contracts/time";
import type { EmploymentType, RawCollectedJobV1 } from "../../contracts/index.ts";
import type {
  CareerCollectOptions,
  CareerSourceAdapter,
  CareerSourceDefinition,
} from "../index.ts";

import {
  AccessBlockedError,
  ConfigError,
  EmptyResultError,
  ParseFailedError,
  RequestTimeoutError,
  SchemaChangedError,
} from "../fetch/errors.ts";
import { createPageRequest } from "../fetch/transport.ts";
import type { FetchTransport, PageRequest } from "../fetch/transport.ts";

/**
 * 北森 zhiye 平台社招列表适配器。
 *
 * 86 家企业共用同一套公开 JSON 接口（匿名可用、无 Cookie / Token / 签名）：
 * `POST https://<tenant>.zhiye.com/api/Jobad/GetJobAdPageList`，社招 = `Category: ["1"]`。
 * 列表条目已含职责（`Duty`）、要求（`Require`）、城市（`LocNames`）、发布时间（`PostDate`），
 * 因此单页只发一次请求，不逐条取详情。平台未提供稳定的单条职位详情 URL，
 * `official_url` 统一使用官方社招列表页，岗位级唯一性由 `source_job_id` 保证。
 */
export const ZHIYE_COLLECTOR_VERSION = "collector/0.2.0";

export const ZHIYE_LIST_PATH = "/api/Jobad/GetJobAdPageList";

export const ZHIYE_DISPLAY_FIELDS: readonly string[] = [
  "Category", "Kind", "LocId", "PostDate", "ClassificationOne",
  "ClassificationTwo", "Org", "Salary", "Degree", "YearsOfWorking", "WorkTime",
];

const PAGE_SIZE = 20;
const MAX_PAGE_LIMIT = 3;
const PAGE_TIMEOUT_MS = 20_000;
const MIN_INTERVAL_MS = 1_000;
const POST_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;
const EMPTY_POST_DATE_PREFIX = "0001-01-01";
function sparseSourceNote(spec: ZhiyeSourceSpec, jobCount: number): string {
  const base = `在招岗位极少（${jobCount} 条）`;
  return spec.sparseEmptyPageSample ? `${base}，样本中空页属真实响应。` : `${base}。`;
}

function zhiyeSourceNotes(spec: ZhiyeSourceSpec): string {
  const base = `北森 zhiye 门户公开社招 JSON（POST /api/Jobad/GetJobAdPageList，匿名可用，无 Cookie/Token/签名），列表条目即含职责与要求；平台未提供稳定单条详情 URL，official_url 统一为官方社招列表页 ${zhiyeJobsPageUrl(spec.tenant)}，岗位级唯一性由 source_job_id 保证。校招 Category=["2"] 暂不采集。`;
  return spec.sparseJobCount === undefined
    ? base
    : `${base}${sparseSourceNote(spec, spec.sparseJobCount)}`;
}

export interface ZhiyeSourceSpec {
  readonly sourceKey: string;
  readonly tenant: string;
  readonly companyName: string;
  readonly label: string;
  /** 在招岗位条数（实测 Count）；仅稀疏源声明，notes 据此标注。 */
  readonly sparseJobCount?: number;
  /** 样本目录中确实落盘了 `Data=[]` 的空页响应；仅此类源在 notes 声明空页为真实响应。 */
  readonly sparseEmptyPageSample?: boolean;
}

/**
 * zhiye 源的 `(sourceKey, tenant, companyName)` 三元组唯一事实来源：
 * `registry.ts` 与本模块的 `ZHIYE_SOURCES` 均从此取值，不得各自硬编码。
 * 顺序与 C-REGISTRY@1 固定清单一致。
 */
export const ZHIYE_SOURCE_SPECS: readonly ZhiyeSourceSpec[] = [
  {
    tenant: "iflytek",
    sourceKey: "iflytek-official-careers",
    label: "科大讯飞官方招聘",
    companyName: "科大讯飞",
  },
  {
    tenant: "dahua",
    sourceKey: "dahua-official-careers",
    label: "大华股份官方招聘",
    companyName: "浙江大华技术股份有限公司",
  },
  {
    tenant: "inovance",
    sourceKey: "inovance-official-careers",
    label: "汇川技术官方招聘",
    companyName: "汇川技术",
  },
  {
    tenant: "sunwoda",
    sourceKey: "sunwoda-official-careers",
    label: "欣旺达官方招聘",
    companyName: "欣旺达",
  },
  {
    tenant: "boe",
    sourceKey: "boe-official-careers",
    label: "京东方官方招聘",
    companyName: "京东方",
  },
  {
    tenant: "sugon",
    sourceKey: "sugon-official-careers",
    label: "中科曙光官方招聘",
    companyName: "中科曙光",
  },
  {
    tenant: "h3c",
    sourceKey: "h3c-official-careers",
    label: "新华三官方招聘",
    companyName: "新华三",
  },
  {
    tenant: "mindray",
    sourceKey: "mindray-official-careers",
    label: "迈瑞医疗官方招聘",
    companyName: "迈瑞医疗",
  },
  {
    tenant: "united-imaging",
    sourceKey: "united-imaging-official-careers",
    label: "联影医疗官方招聘",
    companyName: "联影医疗",
  },
  {
    tenant: "invt",
    sourceKey: "invt-official-careers",
    label: "英威腾官方招聘",
    companyName: "英威腾",
  },
  {
    tenant: "sany",
    sourceKey: "sany-official-careers",
    label: "三一重工官方招聘",
    companyName: "三一重工",
  },
  {
    tenant: "venustech",
    sourceKey: "venustech-official-careers",
    label: "启明星辰官方招聘",
    companyName: "启明星辰",
  },
  {
    tenant: "xinje",
    sourceKey: "xinje-official-careers",
    label: "信捷电气官方招聘",
    companyName: "信捷电气",
  },
  {
    tenant: "roborock",
    sourceKey: "roborock-official-careers",
    label: "石头科技官方招聘",
    companyName: "石头科技",
  },
  {
    tenant: "dreame",
    sourceKey: "dreame-official-careers",
    label: "追觅科技官方招聘",
    companyName: "追觅科技",
  },
  {
    tenant: "aac",
    sourceKey: "aac-official-careers",
    label: "瑞声科技官方招聘",
    companyName: "瑞声科技",
  },
  {
    tenant: "piotech",
    sourceKey: "piotech-official-careers",
    label: "拓荆科技官方招聘",
    companyName: "拓荆科技",
  },
  {
    tenant: "siasun",
    sourceKey: "siasun-official-careers",
    label: "新松机器人官方招聘",
    companyName: "新松机器人",
  },
  {
    tenant: "efort",
    sourceKey: "efort-official-careers",
    label: "埃夫特官方招聘",
    companyName: "埃夫特",
  },
  {
    tenant: "hopewind",
    sourceKey: "hopewind-official-careers",
    label: "禾望电气官方招聘",
    companyName: "禾望电气",
  },
  {
    tenant: "sofarsolar",
    sourceKey: "sofarsolar-official-careers",
    label: "首航新能源官方招聘",
    companyName: "首航新能源",
  },
  {
    tenant: "deye",
    sourceKey: "deye-official-careers",
    label: "德业股份官方招聘",
    companyName: "德业股份",
  },
  {
    tenant: "chipone",
    sourceKey: "chipone-official-careers",
    label: "集创北方官方招聘",
    companyName: "集创北方",
  },
  {
    tenant: "mornsun",
    sourceKey: "mornsun-official-careers",
    label: "金升阳官方招聘",
    companyName: "金升阳",
  },
  {
    tenant: "unitree",
    sourceKey: "unitree-official-careers",
    label: "宇树科技官方招聘",
    companyName: "宇树科技",
  },
  {
    tenant: "maxscend",
    sourceKey: "maxscend-official-careers",
    label: "卓胜微电子官方招聘",
    companyName: "卓胜微电子",
  },
  {
    tenant: "chipsea",
    sourceKey: "chipsea-official-careers",
    label: "芯海科技官方招聘",
    companyName: "芯海科技",
  },
  {
    tenant: "delixi",
    sourceKey: "delixi-official-careers",
    label: "德力西官方招聘",
    companyName: "德力西",
  },
  {
    tenant: "tengen",
    sourceKey: "tengen-official-careers",
    label: "天正电气官方招聘",
    companyName: "天正电气",
  },
  {
    tenant: "goldwind",
    sourceKey: "goldwind-official-careers",
    label: "金风科技官方招聘",
    companyName: "金风科技",
  },
  {
    tenant: "wetown",
    sourceKey: "wetown-official-careers",
    label: "威腾电气集团官方招聘",
    companyName: "威腾电气集团",
  },
  {
    tenant: "cicc",
    sourceKey: "cicc-official-careers",
    label: "中金公司官方招聘",
    companyName: "中金公司",
  },
  {
    tenant: "guosen",
    sourceKey: "guosen-official-careers",
    label: "国信证券官方招聘",
    companyName: "国信证券",
  },
  {
    tenant: "iqiyi",
    sourceKey: "iqiyi-official-careers",
    label: "爱奇艺线下业务官方招聘",
    companyName: "爱奇艺线下业务",
  },
  {
    tenant: "dptech",
    sourceKey: "dptech-official-careers",
    label: "迪普科技官方招聘",
    companyName: "杭州迪普科技股份有限公司",
  },
  {
    tenant: "topsec",
    sourceKey: "topsec-official-careers",
    label: "天融信官方招聘",
    companyName: "天融信科技集团",
  },
  {
    tenant: "zhonghuan",
    sourceKey: "zhonghuan-official-careers",
    label: "TCL中环官方招聘",
    companyName: "TCL中环",
  },
  {
    tenant: "edan",
    sourceKey: "edan-official-careers",
    label: "理邦仪器官方招聘",
    companyName: "理邦仪器",
  },
  {
    tenant: "jaka",
    sourceKey: "jaka-official-careers",
    label: "节卡机器人官方招聘",
    companyName: "节卡机器人",
  },
  {
    tenant: "eoptolink",
    sourceKey: "eoptolink-official-careers",
    label: "新易盛官方招聘",
    companyName: "成都新易盛通信技术股份有限公司",
  },
  {
    tenant: "medcaptain",
    sourceKey: "medcaptain-official-careers",
    label: "麦科田医疗官方招聘",
    companyName: "麦科田医疗",
  },
  {
    tenant: "siglent",
    sourceKey: "siglent-official-careers",
    label: "鼎阳科技官方招聘",
    companyName: "鼎阳科技",
  },
  {
    tenant: "mininglamp",
    sourceKey: "mininglamp-official-careers",
    label: "明略科技官方招聘",
    companyName: "明略科技",
  },
  {
    tenant: "rokid",
    sourceKey: "rokid-official-careers",
    label: "Rokid官方招聘",
    companyName: "Rokid",
  },
  {
    tenant: "unisound",
    sourceKey: "unisound-official-careers",
    label: "云知声官方招聘",
    companyName: "云知声",
  },
  {
    tenant: "hellobike",
    sourceKey: "hellobike-official-careers",
    label: "哈啰官方招聘",
    companyName: "上海哈啰普惠科技有限公司",
  },
  {
    tenant: "nexchip",
    sourceKey: "nexchip-official-careers",
    label: "晶合集成官方招聘",
    companyName: "合肥晶合集成电路股份有限公司",
  },
  {
    tenant: "pylontech",
    sourceKey: "pylontech-official-careers",
    label: "中兴派能官方招聘",
    companyName: "中兴派能",
  },
  {
    tenant: "dobot",
    sourceKey: "dobot-official-careers",
    label: "越疆机器人官方招聘",
    companyName: "越疆机器人",
  },
  {
    tenant: "infypower",
    sourceKey: "infypower-official-careers",
    label: "英飞源官方招聘",
    companyName: "英飞源",
  },
  {
    tenant: "joulwatt",
    sourceKey: "joulwatt-official-careers",
    label: "杰华特官方招聘",
    companyName: "杰华特",
  },
  {
    tenant: "ucloud",
    sourceKey: "ucloud-official-careers",
    label: "UCloud官方招聘",
    companyName: "UCloud",
  },
  {
    tenant: "beisen",
    sourceKey: "beisen-official-careers",
    label: "北森官方招聘",
    companyName: "北森",
  },
  {
    tenant: "fxiaoke",
    sourceKey: "fxiaoke-official-careers",
    label: "纷享销客官方招聘",
    companyName: "纷享销客",
  },
  {
    tenant: "autochips",
    sourceKey: "autochips-official-careers",
    label: "杰发科技官方招聘",
    companyName: "杰发科技",
  },
  {
    tenant: "bestechnic",
    sourceKey: "bestechnic-official-careers",
    label: "恒玄科技官方招聘",
    companyName: "恒玄科技",
  },
  {
    tenant: "biwin",
    sourceKey: "biwin-official-careers",
    label: "佰维存储官方招聘",
    companyName: "佰维存储",
  },
  {
    tenant: "cxmt",
    sourceKey: "cxmt-official-careers",
    label: "长鑫存储官方招聘",
    companyName: "长鑫存储",
  },
  {
    tenant: "longsys",
    sourceKey: "longsys-official-careers",
    label: "江波龙官方招聘",
    companyName: "江波龙",
  },
  {
    tenant: "nanxin",
    sourceKey: "nanxin-official-careers",
    label: "南芯半导体官方招聘",
    companyName: "南芯半导体",
  },
  {
    tenant: "risen",
    sourceKey: "risen-official-careers",
    label: "东方日升官方招聘",
    companyName: "东方日升",
    sparseJobCount: 4,
    sparseEmptyPageSample: true,
  },
  {
    tenant: "tongwei",
    sourceKey: "tongwei-official-careers",
    label: "通威股份官方招聘",
    companyName: "通威股份",
  },
  {
    tenant: "ymtc",
    sourceKey: "ymtc-official-careers",
    label: "长江存储官方招聘",
    companyName: "长江存储",
  },
  {
    tenant: "aqara",
    sourceKey: "aqara-official-careers",
    label: "绿米联创官方招聘",
    companyName: "绿米联创",
  },
  {
    tenant: "awinic",
    sourceKey: "awinic-official-careers",
    label: "艾为电子官方招聘",
    companyName: "艾为电子",
  },
  {
    tenant: "digitalchina",
    sourceKey: "digitalchina-official-careers",
    label: "神州数码官方招聘",
    companyName: "神州数码",
  },
  {
    tenant: "snibe",
    sourceKey: "snibe-official-careers",
    label: "新产业生物官方招聘",
    companyName: "新产业生物",
  },
  {
    tenant: "yusys",
    sourceKey: "yusys-official-careers",
    label: "宇信科技官方招聘",
    companyName: "宇信科技",
  },
  {
    tenant: "leapmotor",
    sourceKey: "leapmotor-official-careers",
    label: "零跑汽车官方招聘",
    companyName: "零跑汽车",
  },
  {
    tenant: "sunlord",
    sourceKey: "sunlord-official-careers",
    label: "南京商络电子官方招聘",
    companyName: "南京商络电子股份有限公司",
  },
  {
    tenant: "winline",
    sourceKey: "winline-official-careers",
    label: "永联科技官方招聘",
    companyName: "深圳永联科技股份有限公司",
  },
  {
    tenant: "changan",
    sourceKey: "changan-official-careers",
    label: "长安汽车官方招聘",
    companyName: "长安汽车",
  },
  {
    tenant: "chery",
    sourceKey: "chery-official-careers",
    label: "奇瑞汽车官方招聘",
    companyName: "奇瑞汽车",
  },
  {
    tenant: "wondershare",
    sourceKey: "wondershare-official-careers",
    label: "万兴科技官方招聘",
    companyName: "万兴科技",
  },
  {
    tenant: "jmc",
    sourceKey: "jmc-official-careers",
    label: "江铃汽车官方招聘",
    companyName: "江铃汽车",
  },
  {
    tenant: "fibocom",
    sourceKey: "fibocom-official-careers",
    label: "广和通官方招聘",
    companyName: "广和通",
  },
  {
    tenant: "neoway",
    sourceKey: "neoway-official-careers",
    label: "有方科技官方招聘",
    companyName: "有方科技",
  },
  {
    tenant: "zhihuiya",
    sourceKey: "zhihuiya-official-careers",
    label: "智慧芽官方招聘",
    companyName: "智慧芽",
  },
  {
    tenant: "advantech",
    sourceKey: "advantech-official-careers",
    label: "研华科技官方招聘",
    companyName: "研华科技",
  },
  {
    tenant: "liteon2",
    sourceKey: "liteon2-official-careers",
    label: "光宝科技官方招聘",
    companyName: "光宝科技",
  },
  {
    tenant: "cosmx",
    sourceKey: "cosmx-official-careers",
    label: "珠海冠宇官方招聘",
    companyName: "珠海冠宇",
  },
  {
    tenant: "apsystems",
    sourceKey: "apsystems-official-careers",
    label: "领储宇能官方招聘",
    companyName: "领储宇能科技有限公司",
    sparseJobCount: 1,
    sparseEmptyPageSample: true,
  },
  {
    tenant: "benq",
    sourceKey: "benq-official-careers",
    label: "明基BenQ官方招聘",
    companyName: "明基BenQ",
    sparseJobCount: 3,
    sparseEmptyPageSample: true,
  },
  {
    tenant: "hwatsing",
    sourceKey: "hwatsing-official-careers",
    label: "华海清科官方招聘",
    companyName: "华海清科",
    sparseJobCount: 1,
  },
  {
    tenant: "amphenol",
    sourceKey: "amphenol-official-careers",
    label: "安费诺光纤官方招聘",
    companyName: "安费诺光纤技术(深圳)有限公司",
    sparseJobCount: 1,
  },
  {
    tenant: "sosen",
    sourceKey: "sosen-official-careers",
    label: "崧盛电子官方招聘",
    companyName: "深圳市崧盛电子股份有限公司",
    sparseJobCount: 1,
  },
];

export const ZHIYE_SOURCES: readonly CareerSourceDefinition[] = ZHIYE_SOURCE_SPECS.map((spec) => ({
  source_key: spec.sourceKey,
  label: spec.label,
  kind: "company_careers",
  entry_url: zhiyeJobsPageUrl(spec.tenant),
  access: "http",
  enabled: true,
  notes: zhiyeSourceNotes(spec),
}));

export function zhiyeSiteUrl(tenant: string): string {
  return `https://${tenant}.zhiye.com`;
}

export function zhiyeJobsPageUrl(tenant: string): string {
  return `${zhiyeSiteUrl(tenant)}/social/jobs`;
}

export function buildZhiyeListBody(pageIndex: number, pageSize: number): Record<string, unknown> {
  return {
    PageIndex: pageIndex,
    PageSize: pageSize,
    Category: ["1"],
    KeyWords: "",
    SpecialType: 0,
    PortalId: "",
    DisplayFields: ZHIYE_DISPLAY_FIELDS,
  };
}

export interface ZhiyeJobSummary {
  readonly id: string;
  readonly title: string;
  readonly locations: readonly string[];
  readonly duty: string | null;
  readonly requirement: string | null;
  readonly degreeRaw: string | null;
  readonly experienceRaw: string | null;
  readonly employmentType: EmploymentType;
  readonly publishedAt: string | null;
  readonly org: string | null;
  readonly salary: string | null;
  readonly raw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeLocations(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = text(entry);
    if (name !== null) {
      seen.add(name);
    }
  }
  return [...seen];
}

function normalizeId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/**
 * PostDate 形如 `2026-11-10T14:12:17`，按日期截断；零值 `0001-01-01T00:00:00`、
 * 空串与不可解析值返回 null（平台用零值表示「未设置」）。
 */
function parseZhiyePostDate(value: unknown): string | null {
  const raw = text(value);
  if (raw === null || raw.startsWith(EMPTY_POST_DATE_PREFIX)) {
    return null;
  }
  const match = POST_DATE_PATTERN.exec(raw);
  if (match === null) {
    return null;
  }
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  return Number.isNaN(new Date(`${date}T00:00:00Z`).getTime()) ? null : date;
}

function mapEmploymentType(kind: string | null): EmploymentType {
  // 社招列表（Category=["1"]）中 Kind 缺省即社招全职，平台有时省略该字段。
  if (kind === null) {
    return "experienced";
  }
  if (kind.includes("实习")) {
    return "internship";
  }
  if (kind.includes("全职") || kind.includes("社会招聘")) {
    return "experienced";
  }
  return "unknown";
}

function toSummary(item: Record<string, unknown>): ZhiyeJobSummary {
  const id = normalizeId(item["JobAdId"]);
  const title = text(item["JobAdName"]);
  if (id === null || title === null) {
    throw new ParseFailedError("zhiye 列表条目缺少 JobAdId / JobAdName");
  }
  return {
    id,
    title,
    locations: normalizeLocations(item["LocNames"]),
    duty: text(item["Duty"]),
    requirement: text(item["Require"]),
    degreeRaw: text(item["Degree"]),
    experienceRaw: text(item["YearsOfWorking"]),
    employmentType: mapEmploymentType(text(item["Kind"])),
    publishedAt: parseZhiyePostDate(item["PostDate"]),
    org: text(item["Org"]),
    salary: text(item["Salary"]),
    raw: item,
  };
}

export function parseZhiyeList(body: Buffer | string): ZhiyeJobSummary[] {
  let parsed: unknown;
  try {
    parsed = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.toString("utf8"));
  } catch {
    throw new SchemaChangedError("zhiye 列表响应不是合法 JSON", undefined);
  }
  if (!isRecord(parsed)) {
    throw new SchemaChangedError("zhiye 列表响应不是对象");
  }
  const code = parsed["Code"];
  if (Number(code) !== 200) {
    throw new SchemaChangedError(
      `zhiye 列表响应状态异常：Code=${code === undefined ? "null" : String(code)}`,
    );
  }
  const data = parsed["Data"];
  if (!Array.isArray(data)) {
    throw new SchemaChangedError("zhiye 列表响应缺少 Data 数组");
  }
  if (data.length === 0) {
    throw new EmptyResultError("zhiye 列表响应 Data 为空数组");
  }
  return data.map((item) => {
    if (!isRecord(item)) {
      throw new ParseFailedError("zhiye 列表条目不是对象");
    }
    return toSummary(item);
  });
}

export interface ZhiyeRawJobContext {
  readonly sourceKey: string;
  readonly companyName: string;
  readonly jobsPageUrl: string;
  readonly fetchedAt: string;
}

export function toZhiyeRawJob(item: ZhiyeJobSummary, ctx: ZhiyeRawJobContext): RawCollectedJobV1 {
  const sections = [item.duty, item.requirement].filter(
    (section): section is string => section !== null,
  );
  if (sections.length === 0) {
    throw new ParseFailedError(`zhiye 职位 ${item.id} 缺少职责与要求正文`, ctx.sourceKey);
  }

  return {
    schema_version: "1.0",
    source_key: ctx.sourceKey,
    source_job_id: item.id,
    company_name: ctx.companyName,
    title: item.title,
    official_url: ctx.jobsPageUrl,
    raw_text: sections.join("\n\n"),
    raw_payload: item.raw,
    // 平台 PostDate 是北京墙上时间；published_at 需为 UTC ISO，取北京时间当日 00:00 的 UTC 表达。
    published_at: item.publishedAt === null ? null : beijingAt(item.publishedAt, "00:00").toISOString(),
    fetched_at: ctx.fetchedAt,
    collector_version: ZHIYE_COLLECTOR_VERSION,
    hints: {
      role_family: "unknown",
      locations: [...item.locations],
      degree_raw: item.degreeRaw,
      experience_raw: item.experienceRaw,
      employment_type: item.employmentType,
      skill_terms: [],
    },
  };
}

export interface ZhiyeAdapterOptions {
  readonly tenant: string;
  readonly sourceKey: string;
  readonly companyName: string;
  readonly pageLimit?: number;
  readonly definition?: CareerSourceDefinition;
  readonly sleep?: (ms: number) => Promise<void>;
  /** 兼容既有构造参数；`fetched_at` 一律取响应采集时刻，不使用本地时钟。 */
  readonly now?: () => string;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * 限流/鉴权/服务端错误不是结构变更：按 access_blocked 或瞬态 timeout 上报，
 * 否则告警与降级判断会把它们误记为 schema_changed。
 */
function classifyHttpStatus(status: number, sourceKey: string): void {
  if (status === 429) {
    throw new AccessBlockedError("rate_limit", "zhiye 列表响应 HTTP 429（触发限流）", sourceKey);
  }
  if (status === 403) {
    throw new AccessBlockedError("forbidden", "zhiye 列表响应 HTTP 403（禁止访问）", sourceKey);
  }
  if (status >= 500 && status <= 599) {
    throw new RequestTimeoutError(`zhiye 列表响应 HTTP ${status}（服务端错误，瞬态）`, sourceKey);
  }
}

function buildListRequest(
  url: string,
  pageIndex: number,
  sourceKey: string,
  signal: AbortSignal | undefined,
): PageRequest {
  return createPageRequest({
    url,
    sourceKey,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(buildZhiyeListBody(pageIndex, PAGE_SIZE)),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** 解析函数不带 sourceKey，适配器路径上补回，便于失败归因到具体信源。 */
function attachSourceKey(error: unknown, sourceKey: string): unknown {
  if (!(error instanceof SchemaChangedError) && !(error instanceof ParseFailedError) && !(error instanceof EmptyResultError)) {
    return error;
  }
  if (error.sourceKey !== undefined) {
    return error;
  }
  if (error instanceof SchemaChangedError) {
    return new SchemaChangedError(error.message, sourceKey);
  }
  if (error instanceof ParseFailedError) {
    return new ParseFailedError(error.message, sourceKey);
  }
  return new EmptyResultError(error.message, sourceKey);
}

export function createZhiyeOfficialCareersAdapter(
  transport: FetchTransport,
  options: ZhiyeAdapterOptions,
): CareerSourceAdapter {
  const definition =
    options.definition ??
    ZHIYE_SOURCES.find((item) => item.source_key === options.sourceKey);
  if (definition === undefined) {
    throw new ConfigError(`来源 ${options.sourceKey} 未在 ZHIYE_SOURCES 中登记`);
  }
  const defaultPageLimit = Math.max(1, Math.min(options.pageLimit ?? 1, MAX_PAGE_LIMIT));
  const listUrl = `${zhiyeSiteUrl(options.tenant)}${ZHIYE_LIST_PATH}`;
  const jobsPageUrl = zhiyeJobsPageUrl(options.tenant);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    definition,
    async collect(
      signal?: AbortSignal,
      callOptions?: CareerCollectOptions,
    ): Promise<RawCollectedJobV1[]> {
      const pageLimit = Math.max(1, Math.min(callOptions?.pageLimit ?? defaultPageLimit, MAX_PAGE_LIMIT));
      const jobs: RawCollectedJobV1[] = [];
      const seenJobIds = new Set<string>();
      for (let pageIndex = 0; pageIndex < pageLimit; pageIndex += 1) {
        if (isAborted(signal)) {
          throw new DOMException("采集被取消", "AbortError");
        }
        if (pageIndex > 0) {
          await sleep(MIN_INTERVAL_MS);
        }
        const response = await transport.fetchPage(
          buildListRequest(listUrl, pageIndex, definition.source_key, signal),
        );
        classifyHttpStatus(response.status, definition.source_key);
        let summaries: ZhiyeJobSummary[];
        try {
          summaries = parseZhiyeList(response.body);
        } catch (error) {
          // 首页空 Data 视为该源当前无在招岗位；后续页空 Data 只表示翻页到底，保留已采结果。
          if (pageIndex > 0 && error instanceof EmptyResultError) {
            break;
          }
          throw attachSourceKey(error, definition.source_key);
        }
        for (const summary of summaries) {
          if (isAborted(signal)) {
            throw new DOMException("采集被取消", "AbortError");
          }
          if (seenJobIds.has(summary.id)) {
            continue;
          }
          seenJobIds.add(summary.id);
          jobs.push(
            toZhiyeRawJob(summary, {
              sourceKey: definition.source_key,
              companyName: options.companyName,
              jobsPageUrl,
              fetchedAt: response.fetchedAt,
            }),
          );
        }
      }
      return jobs;
    },
  };
}