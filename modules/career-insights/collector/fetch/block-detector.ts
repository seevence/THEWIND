import { AccessBlockedError } from "./errors.ts";

export interface BlockProbeInput {
  readonly status: number;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly bodyText: string;
  readonly sourceKey: string;
}

const CAPTCHA_MARKERS: readonly string[] = [
  "验证码",
  "人机验证",
  "captcha",
  "geetest",
  "滑动验证",
  "安全验证",
];

const LOGIN_MARKERS: readonly string[] = ["login", "signin", "passport", "sso", "登录"];

const PAYWALL_MARKERS: readonly string[] = [
  "付费后查看",
  "订阅后查看",
  "登录后查看全文",
  "paywall",
  "purchase to view",
];

function redirectedToDifferentPath(input: BlockProbeInput): boolean {
  try {
    const request = new URL(input.requestUrl);
    const final = new URL(input.finalUrl);
    return request.host !== final.host || request.pathname !== final.pathname;
  } catch {
    return false;
  }
}

export function detectBlock(input: BlockProbeInput): AccessBlockedError | null {
  if (input.status === 401) {
    return new AccessBlockedError("unauthorized", "HTTP 401 需要登录凭据", input.sourceKey);
  }
  if (input.status === 403) {
    return new AccessBlockedError("forbidden", "HTTP 403 禁止访问", input.sourceKey);
  }
  if (input.status === 429) {
    return new AccessBlockedError("rate_limited", "HTTP 429 触发限频", input.sourceKey);
  }

  const lowerBody = input.bodyText.toLowerCase();
  if (CAPTCHA_MARKERS.some((marker) => lowerBody.includes(marker.toLowerCase()))) {
    return new AccessBlockedError("captcha", "出现验证码或人机验证", input.sourceKey);
  }

  const finalPath = input.finalUrl.toLowerCase();
  if (redirectedToDifferentPath(input) && LOGIN_MARKERS.some((marker) => finalPath.includes(marker))) {
    return new AccessBlockedError("login_required", "被重定向到登录入口", input.sourceKey);
  }

  if (PAYWALL_MARKERS.some((marker) => lowerBody.includes(marker.toLowerCase()))) {
    return new AccessBlockedError("paywall", "出现付费墙", input.sourceKey);
  }

  return null;
}