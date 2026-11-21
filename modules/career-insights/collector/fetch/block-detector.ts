import { AccessBlockedError } from "./errors.ts";

export interface BlockProbeInput {
  readonly status: number;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly bodyText: string;
  /** 响应 Content-Type：JSON 接口的正文里可能出现「安全验证」等业务词，不能当验证码页面。 */
  readonly contentType?: string | null;
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

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ");
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

  // 只对网页正文做验证码/付费墙文案扫描：JSON API 的业务字段里可能出现「安全验证」「登录」等词。
  const bodyTextIsWebPage = input.contentType === undefined || input.contentType === null || !/json/i.test(input.contentType);
  // 只扫网页的可见文本：脚本/样式里的「验证码」生成器、input 的 placeholder（如中国建筑登录框）
  // 都不代表页面被拦截；真正的验证码页会把提示放在可见文本里。
  const markerText = bodyTextIsWebPage ? stripHtmlToText(input.bodyText) : input.bodyText;
  const lowerBody = markerText.toLowerCase();
  if (bodyTextIsWebPage && CAPTCHA_MARKERS.some((marker) => lowerBody.includes(marker.toLowerCase()))) {
    return new AccessBlockedError("captcha", "出现验证码或人机验证", input.sourceKey);
  }

  const finalPath = input.finalUrl.toLowerCase();
  if (redirectedToDifferentPath(input) && LOGIN_MARKERS.some((marker) => finalPath.includes(marker))) {
    return new AccessBlockedError("login_required", "被重定向到登录入口", input.sourceKey);
  }

  if (bodyTextIsWebPage && PAYWALL_MARKERS.some((marker) => lowerBody.includes(marker.toLowerCase()))) {
    return new AccessBlockedError("paywall", "出现付费墙", input.sourceKey);
  }

  return null;
}