import { detectBlock } from "./block-detector.ts";
import { AccessBlockedError, ConfigError, RequestTimeoutError, SchemeDowngradeError } from "./errors.ts";
import { networkCallCounter } from "./transport.ts";
import type { FetchTransport, PageRequest, TransportResponse } from "./transport.ts";

const CHARSET_PATTERN = /charset=["']?([A-Za-z0-9_-]+)/i;

function decodeBody(
  body: Buffer,
  contentType: string | null,
  headers: Readonly<Record<string, string>>,
): string {
  let charset: string | null = null;
  if (contentType !== null) {
    charset = CHARSET_PATTERN.exec(contentType)?.[1] ?? null;
  }
  if (charset === null) {
    const headerCharset = headers["content-type"] ?? null;
    if (headerCharset !== null) {
      charset = CHARSET_PATTERN.exec(headerCharset)?.[1] ?? null;
    }
  }
  if (charset === null) {
    charset = CHARSET_PATTERN.exec(body.subarray(0, 2048).toString("latin1"))?.[1] ?? null;
  }
  try {
    return new TextDecoder(charset?.toLowerCase() ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}


const MAX_REDIRECTS = 5;

function assertSupportedScheme(url: string, sourceKey: string, label: string): string {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new SchemeDowngradeError(`${label}不是合法 URL：${url}`, sourceKey);
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new SchemeDowngradeError(`${label}协议不受支持：${protocol}`, sourceKey);
  }
  return protocol;
}

function assertNoSchemeDowngrade(fromUrl: string, toUrl: string, sourceKey: string): void {
  const from = assertSupportedScheme(fromUrl, sourceKey, "当前请求");
  const to = assertSupportedScheme(toUrl, sourceKey, "重定向目标");
  if (from === "https:" && to === "http:") {
    throw new SchemeDowngradeError(
      `HTTPS 请求被重定向降级到 HTTP：${fromUrl} → ${toUrl}`,
      sourceKey,
    );
  }
}

interface FollowResult {
  readonly response: Response;
  readonly finalUrl: string;
}

/**
 * 手动跟随重定向，逐跳校验协议。
 * 使用 redirect:"manual" 是因为 fetch 只暴露最终 URL，链式 https→http→https 在 follow 模式下不可见。
 */
async function followRedirects(
  fetchImpl: typeof fetch,
  request: PageRequest,
  signal: AbortSignal,
): Promise<FollowResult> {
  let currentUrl = request.url;
  assertSupportedScheme(currentUrl, request.sourceKey, "请求");
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(currentUrl, {
      method: request.method,
      headers: request.headers,
      redirect: "manual",
      signal,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    if (response.status >= 300 && response.status < 400) {
      if (request.method === "POST") {
        throw new ConfigError(
          `POST 请求不接受重定向（${response.status}）：${currentUrl}`,
          request.sourceKey,
        );
      }
      const location = response.headers.get("location");
      if (location === null) {
        return { response, finalUrl: currentUrl };
      }
      const nextUrl = new URL(location, currentUrl).toString();
      assertNoSchemeDowngrade(currentUrl, nextUrl, request.sourceKey);
      currentUrl = nextUrl;
      continue;
    }
    return { response, finalUrl: currentUrl };
  }
  throw new AccessBlockedError(
    "redirect_loop",
    `重定向超过 ${MAX_REDIRECTS} 跳：${request.url}`,
    request.sourceKey,
  );
}

export interface HttpTransportOptions {
  readonly fetchImpl?: typeof fetch;
}

export class HttpTransport implements FetchTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpTransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async fetchPage(request: PageRequest): Promise<TransportResponse> {
    networkCallCounter.increment();
    const timeoutMs = Math.min(request.pageTimeoutMs, 30_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const signal =
        request.signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, request.signal]);
      const { response, finalUrl } = await followRedirects(this.fetchImpl, request, signal);
      const body = Buffer.from(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const contentType = headers["content-type"] ?? null;
      const blocked = detectBlock({
        status: response.status,
        requestUrl: request.url,
        finalUrl,
        bodyText: decodeBody(body, contentType, headers),
        sourceKey: request.sourceKey,
      });
      if (blocked !== null) {
        throw blocked;
      }
      return {
        status: response.status,
        requestUrl: request.url,
        finalUrl,
        contentType,
        headers,
        body,
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (request.signal?.aborted === true) {
          throw error;
        }
        throw new RequestTimeoutError(`单页请求在 ${timeoutMs}ms 后超时`, request.sourceKey);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}