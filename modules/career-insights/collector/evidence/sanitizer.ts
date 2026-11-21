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
const CN_MOBILE_PATTERN = /(?:^|[^\d])1[3-9]\d{9}(?!\d)/;
const CONTACT_SECTION_PATTERN = /(?:联系人|联系方式|联系电话|简历投递)\s*[:：][^\n]{0,40}/;

export function containsPersonalData(text: string): boolean {
  return (
    EMAIL_PATTERN.test(text) ||
    CN_MOBILE_PATTERN.test(text) ||
    CONTACT_SECTION_PATTERN.test(text)
  );
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

export type SanitizeResult =
  | { readonly ok: true; readonly headers: Record<string, string>; readonly sanitized: true }
  | { readonly ok: false; readonly reason: string; readonly body_rewritten: false };

export function sanitizeSample(input: {
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
}): SanitizeResult {
  const stripped = stripSensitiveHeaders(input.headers);
  if (containsPersonalData(input.bodyText)) {
    return { ok: false, reason: "personal_data_in_body", body_rewritten: false };
  }
  return { ok: true, headers: stripped.headers, sanitized: true };
}