export const SENSITIVE_HEADERS: readonly string[] = [
  "set-cookie",
  "cookie",
  "authorization",
  "proxy-authorization",
  "x-auth-token",
  "x-csrf-token",
  "x-api-key",
];

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// 前后不得紧邻十六进制字符或 `-`：毫秒时间戳（1795153028000）与 UUID 段
// （a2fc6e75-2426-4799-b9c9-13708838236c 中的 1370883823）因此都不会被当成手机号。
const CN_MOBILE_PATTERN = /(?<![0-9a-fA-F-])1[3-9]\d{9}(?![0-9a-fA-F-])/;
// 段落不得跨越 JSON 字符串边界（`"`）、转义序列（`\`）、HTML 标签（`<`）或换行：
// 否则 `"Duty":"简历投递：hr@example.com","Require":…` 会把 `","Require":` 一起吃掉，
// 打码后 JSON 非法（review N1）。
const CONTACT_SECTION_PATTERN = /(?:联系人|联系方式|联系电话|简历投递)[^\S\n]*[:：][^"\\<\n]{0,40}/;

const EMAIL_REDACT = new RegExp(EMAIL_PATTERN.source, "g");
const CN_MOBILE_REDACT = new RegExp(CN_MOBILE_PATTERN.source, "g");
const CONTACT_SECTION_REDACT = new RegExp(CONTACT_SECTION_PATTERN.source, "g");

const POST_DATE_INT_PATTERN = /"PostDateInt"\s*:\s*\d{13}/;
const ORG_PHONE_PATTERN = /(?<![\d-])(?:0\d{2,3}-\d{7,8}|(?:400|800)-?\d{3}-?\d{4})(?![\d-])/;
const ICP_LICENSE_PATTERN = /ICP[备证]\s*\d+号?/;

export const REDACTED_EMAIL = "[redacted-email]";
export const REDACTED_PHONE = "[redacted-phone]";
export const REDACTED_CONTACT = "[redacted-contact]";

export interface PersonalDataCounts {
  readonly email: number;
  readonly phone: number;
  readonly contact: number;
}

export interface PersonalDataRedaction {
  readonly text: string;
  readonly counts: PersonalDataCounts;
}

export function containsPersonalData(text: string): boolean {
  return (
    EMAIL_PATTERN.test(text) ||
    CN_MOBILE_PATTERN.test(text) ||
    CONTACT_SECTION_PATTERN.test(text)
  );
}

/**
 * 只打码真实个人数据：邮箱、11 位手机号、以及携带邮箱/手机号的
 * `联系人|联系方式|联系电话|简历投递` 段落。
 * 机构总机座机、ICP 备案号与 `PostDateInt` 毫秒时间戳不是个人数据，保留原文。
 */
export function redactPersonalData(text: string): PersonalDataRedaction {
  let email = 0;
  let phone = 0;
  let contact = 0;

  let output = text.replace(EMAIL_REDACT, () => {
    email += 1;
    return REDACTED_EMAIL;
  });
  output = output.replace(CN_MOBILE_REDACT, () => {
    phone += 1;
    return REDACTED_PHONE;
  });
  output = output.replace(CONTACT_SECTION_REDACT, (segment) => {
    if (!segment.includes(REDACTED_EMAIL) && !segment.includes(REDACTED_PHONE)) {
      return segment;
    }
    contact += 1;
    return REDACTED_CONTACT;
  });

  return { text: output, counts: { email, phone, contact } };
}

export type PersonalDataFalsePositive =
  | "post_date_int_timestamp"
  | "org_phone"
  | "icp_license";

/** 形似个人数据但实为站点/平台数据的启发式命中，仅记录原因，不改写原文。 */
export function detectFalsePositivePersonalData(
  text: string,
): readonly PersonalDataFalsePositive[] {
  const reasons: PersonalDataFalsePositive[] = [];
  if (POST_DATE_INT_PATTERN.test(text)) {
    reasons.push("post_date_int_timestamp");
  }
  if (ORG_PHONE_PATTERN.test(text)) {
    reasons.push("org_phone");
  }
  if (ICP_LICENSE_PATTERN.test(text)) {
    reasons.push("icp_license");
  }
  return reasons;
}

export interface HeaderStripResult {
  readonly headers: Record<string, string>;
  readonly removed: readonly string[];
}

export function stripSensitiveHeaders(
  headers: Readonly<Record<string, string>>,
): HeaderStripResult {
  const kept: Record<string, string> = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.includes(key.toLowerCase())) {
      removed.push(key);
      continue;
    }
    kept[key] = value;
  }
  return { headers: kept, removed };
}

export interface SanitizeResult {
  /** false 表示正文命中真实个人数据（已打码）。 */
  readonly ok: boolean;
  readonly reason: string | null;
  readonly headers: Record<string, string>;
  /** 可直接落盘的正文；命中个人数据时为打码后的文本。 */
  readonly bodyText: string;
  readonly body_rewritten: boolean;
  /** meta.sanitized：打码后或本就干净为 true；仅有启发式误报命中时为 false。 */
  readonly sanitized: boolean;
  readonly sanitize_note: string | null;
  readonly personal_data: PersonalDataCounts;
}

function buildSanitizeNote(
  counts: PersonalDataCounts,
  falsePositives: readonly PersonalDataFalsePositive[],
): string | null {
  const parts: string[] = [];
  if (counts.email > 0) {
    parts.push(`email=${counts.email}`);
  }
  if (counts.phone > 0) {
    parts.push(`phone=${counts.phone}`);
  }
  if (counts.contact > 0) {
    parts.push(`contact=${counts.contact}`);
  }
  if (parts.length > 0) {
    return `redacted:${parts.join(",")}`;
  }
  if (falsePositives.length > 0) {
    return `false_positive:${falsePositives.join(",")}`;
  }
  return null;
}

export function sanitizeSample(input: {
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
}): SanitizeResult {
  const stripped = stripSensitiveHeaders(input.headers);
  const redacted = redactPersonalData(input.bodyText);
  const { email, phone, contact } = redacted.counts;
  const bodyRewritten = email + phone + contact > 0;
  const falsePositives = bodyRewritten ? [] : detectFalsePositivePersonalData(input.bodyText);

  return {
    ok: !bodyRewritten,
    reason: bodyRewritten ? "personal_data_in_body" : null,
    headers: stripped.headers,
    bodyText: redacted.text,
    body_rewritten: bodyRewritten,
    sanitized: bodyRewritten || falsePositives.length === 0,
    sanitize_note: buildSanitizeNote(redacted.counts, falsePositives),
    personal_data: redacted.counts,
  };
}