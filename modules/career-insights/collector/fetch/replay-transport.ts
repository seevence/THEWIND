import { createHash } from "node:crypto";
import { ReplaySampleMissingError } from "./errors.ts";
import type { FetchTransport, PageRequest, TransportResponse } from "./transport.ts";

export interface ReplaySample {
  readonly request_key: string;
  readonly captured_at: string;
  readonly status: number;
  readonly request_url: string;
  readonly final_url: string;
  readonly content_type: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

/**
 * POST 的可回放键必须区分请求体：同一 URL 不同页码 body 不同，不能撞成同一份样本。
 * GET 保持原格式，避免已有样本失效。
 */
export function computeRequestKey(url: string, method = "GET", body?: string): string {
  const base = `${method.toUpperCase()} ${url}`;
  if (body === undefined) {
    return base;
  }
  return `${base}#${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
}

export class ReplayTransport implements FetchTransport {
  private readonly samples: readonly ReplaySample[];
  private readonly anchorIso: string | null;

  constructor(samples: readonly ReplaySample[], anchorIso: string | null = null) {
    this.samples = samples;
    this.anchorIso = anchorIso;
  }

  async fetchPage(request: PageRequest): Promise<TransportResponse> {
    const key = computeRequestKey(request.url, request.method, request.body);
    const anchorMs = this.anchorIso === null ? null : Date.parse(this.anchorIso);
    const sample = this.samples
      .filter((candidate) => candidate.request_key === key)
      .filter((candidate) => anchorMs === null || Date.parse(candidate.captured_at) <= anchorMs)
      .sort((left, right) => Date.parse(right.captured_at) - Date.parse(left.captured_at))[0];

    if (sample === undefined) {
      throw new ReplaySampleMissingError(`缺少 ${key} 的回放样本`, request.sourceKey);
    }

    return {
      status: sample.status,
      requestUrl: sample.request_url,
      finalUrl: sample.final_url,
      contentType: sample.content_type,
      headers: sample.headers,
      body: sample.body,
      fetchedAt: sample.captured_at,
    };
  }
}