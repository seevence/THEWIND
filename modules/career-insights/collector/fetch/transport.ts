export interface FetchTransport {
  fetchPage(request: PageRequest): Promise<TransportResponse>;
}

export type PageMethod = "GET" | "POST";

export interface PageRequest {
  readonly url: string;
  readonly method: PageMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly pageTimeoutMs: number;
  readonly sourceKey: string;
  readonly signal?: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly fetchedAt: string;
}

export const networkCallCounter = {
  count: 0,
  reset(): void {
    this.count = 0;
  },
  increment(): void {
    this.count += 1;
  },
};

export function createPageRequest(input: {
  url: string;
  sourceKey: string;
  pageTimeoutMs: number;
  method?: PageMethod;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  signal?: AbortSignal;
}): PageRequest {
  return {
    url: input.url,
    method: input.method ?? "GET",
    headers: { ...(input.headers ?? {}) },
    ...(input.body === undefined ? {} : { body: input.body }),
    pageTimeoutMs: Math.min(input.pageTimeoutMs, 30_000),
    sourceKey: input.sourceKey,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}