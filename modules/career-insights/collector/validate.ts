import type {
  EmploymentType,
  RawCollectedJobV1,
  RoleFamily,
} from "../contracts/index.ts";

export interface ValidationIssueV1 {
  path: string;
  message: string;
}

export type ValidationResultV1<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationIssueV1[] };

const ROLE_FAMILIES: readonly RoleFamily[] = [
  "ai_algorithm",
  "ai_application_development",
  "data",
  "ai_product_operations",
  "hardware_engineering",
  "manufacturing_quality",
  "sales_business",
  "corporate_functions",
  "unknown",
];
const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  "campus",
  "internship",
  "experienced",
  "other",
  "unknown",
];
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const CN_MOBILE_PATTERN = /(?:^|[^\d])1[3-9]\d{9}(?!\d)/;
const CONTACT_SECTION_PATTERN = /(?:联系人|联系方式|联系电话|简历投递)\s*[:：][^\n]{0,40}/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;

  const milliseconds = (match[7] ?? "").padEnd(3, "0");
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${milliseconds}Z`;
  return date.toISOString() === normalized;
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function containsPersonalData(text: string): boolean {
  return (
    EMAIL_PATTERN.test(text) ||
    CN_MOBILE_PATTERN.test(text) ||
    CONTACT_SECTION_PATTERN.test(text)
  );
}

function checkHints(value: unknown, errors: ValidationIssueV1[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "hints", message: "hints 必须是对象" });
    return;
  }

  if (value["role_family"] !== undefined && !ROLE_FAMILIES.includes(value["role_family"] as RoleFamily)) {
    errors.push({ path: "hints.role_family", message: "role_family 取值不在契约枚举内" });
  }
  if (
    value["employment_type"] !== undefined &&
    !EMPLOYMENT_TYPES.includes(value["employment_type"] as EmploymentType)
  ) {
    errors.push({ path: "hints.employment_type", message: "employment_type 取值不在契约枚举内" });
  }
  if (value["degree_raw"] !== undefined && value["degree_raw"] !== null && !isNonEmptyString(value["degree_raw"])) {
    errors.push({ path: "hints.degree_raw", message: "degree_raw 必须是原文字符串或 null" });
  }
  if (
    value["experience_raw"] !== undefined &&
    value["experience_raw"] !== null &&
    !isNonEmptyString(value["experience_raw"])
  ) {
    errors.push({ path: "hints.experience_raw", message: "experience_raw 必须是原文字符串或 null" });
  }
  for (const key of ["locations", "skill_terms"] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((item) => !isNonEmptyString(item))) {
      errors.push({ path: `hints.${key}`, message: `${key} 必须是非空字符串数组` });
    }
  }

  for (const key of Object.keys(value)) {
    if (
      ["role_family", "locations", "degree_raw", "experience_raw", "employment_type", "skill_terms"].includes(
        key,
      )
    ) {
      continue;
    }
    errors.push({ path: `hints.${key}`, message: `hints 中不允许出现派生字段 ${key}` });
  }
}

export function validateRawCollectedJob(value: unknown): ValidationResultV1<RawCollectedJobV1> {
  if (!isRecord(value)) {
    return { ok: false, errors: [{ path: "", message: "职位原始记录必须是对象" }] };
  }

  const errors: ValidationIssueV1[] = [];

  if (value["schema_version"] !== "1.0") {
    errors.push({ path: "schema_version", message: "schema_version 必须为 1.0" });
  }
  if (!isNonEmptyString(value["source_key"])) {
    errors.push({ path: "source_key", message: "source_key 必填" });
  }
  if (!isNonEmptyString(value["company_name"])) {
    errors.push({ path: "company_name", message: "company_name 必须保留官方页面原文" });
  }
  if (!isNonEmptyString(value["title"])) {
    errors.push({ path: "title", message: "title 必须保留官方页面原文" });
  }
  if (!isHttpUrl(value["official_url"])) {
    errors.push({ path: "official_url", message: "official_url 必须是公开可访问的 http(s) 链接" });
  }
  if (!isNonEmptyString(value["raw_text"])) {
    errors.push({ path: "raw_text", message: "raw_text 必须保留官方页面原文" });
  } else if (containsPersonalData(value["raw_text"])) {
    errors.push({ path: "raw_text", message: "raw_text 含个人联系方式，采集层不得收录" });
  }
  if (!isNonEmptyString(value["collector_version"])) {
    errors.push({ path: "collector_version", message: "collector_version 必填" });
  }

  const sourceJobId = value["source_job_id"];
  if (sourceJobId !== null && !isNonEmptyString(sourceJobId)) {
    errors.push({ path: "source_job_id", message: "source_job_id 必须是原文字符串或 null" });
  }

  const publishedAt = value["published_at"];
  if (publishedAt !== null && !isUtcTimestamp(publishedAt)) {
    errors.push({ path: "published_at", message: "published_at 必须是 UTC ISO 8601 或 null" });
  }
  if (!isUtcTimestamp(value["fetched_at"])) {
    errors.push({ path: "fetched_at", message: "fetched_at 必须是本次抓取时间的 UTC ISO 8601" });
  }
  if (isUtcTimestamp(publishedAt) && isUtcTimestamp(value["fetched_at"])) {
    if (Date.parse(publishedAt) > Date.parse(value["fetched_at"])) {
      errors.push({ path: "published_at", message: "published_at 不得晚于 fetched_at" });
    }
  }

  if (value["raw_payload"] !== undefined && !isRecord(value["raw_payload"])) {
    errors.push({ path: "raw_payload", message: "raw_payload 必须是未经改写的原始响应对象" });
  }

  checkHints(value["hints"], errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: value as unknown as RawCollectedJobV1 };
}