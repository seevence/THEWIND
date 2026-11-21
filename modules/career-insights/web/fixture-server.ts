import { createServer, type ServerResponse } from "node:http";
import type { ApiErrorResponseV1 } from "@aihot/career-insights/contracts";
import {
  FIXTURE_DAILY_V1,
  FIXTURE_HOT_V1,
  FIXTURE_JOB_DETAIL_V1,
  FIXTURE_JOB_LIST_V1,
  FIXTURE_POLICY_LIST_V1,
  FIXTURE_SIGNALS_V1,
  FIXTURE_SUMMARY_V1,
} from "../fixtures/api.ts";
import { POLICY_SOURCE_OPTIONS, THEME_LABELS } from "./labels.ts";

const HOST = "127.0.0.1";
/** 断言时用 CAREER_FIXTURE_PORT 避开并行测试的 3101。 */
const PORT = Number(process.env.CAREER_FIXTURE_PORT) || 3101;
const MAX_PAGE = 10_000;
const MAX_PAGE_SIZE = 100;
const MAX_LIMIT = 50;
const MAX_WINDOW_DAYS = 365;

/** fixture 条目没有 source_key 字段；按位置把 6 条样例分配给启用的政策源，模拟后端按 source_key 过滤。 */
const POLICY_SOURCE_ITEM_INDEXES: Readonly<Record<string, readonly number[]>> = {
  "state-council-policy": [0, 2, 4],
  "ndrc-policy": [1, 3, 5],
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: ApiErrorResponseV1["error"]["code"], message: string): void {
  send(res, status, { error: { code, message } } satisfies ApiErrorResponseV1);
}

function positiveInteger(raw: string | null, fallback: number, maximum: number): number | null {
  if (raw === null) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= maximum ? value : null;
}

function unsupportedQuery(params: URLSearchParams, allowed: readonly string[]): string | undefined {
  return [...params.keys()].find((key) => !allowed.includes(key));
}

/** 测试读取最近一次政策请求的参数，断言 loader 与分页把查询原样传给 API。 */
export const policyRequests: URLSearchParams[] = [];

/** 测试读取最近一次 hot / daily / signals 请求，断言 loader 的地址与参数。 */
export const feedRequests: Array<{ pathname: string; params: URLSearchParams }> = [];

export const fixtureServer = createServer((req, res) => {
  try {
    if (req.method !== "GET") {
      sendError(res, 405, "invalid_parameter", "method_not_allowed");
      return;
    }

    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    const { pathname, searchParams } = url;
    if (pathname === "/api/site/career-insights/summary") {
      send(res, 200, FIXTURE_SUMMARY_V1);
      return;
    }
    if (pathname === "/api/site/career-insights/jobs") {
      send(res, 200, FIXTURE_JOB_LIST_V1);
      return;
    }
    if (pathname === "/api/site/career-insights/hot" || pathname === "/api/site/career-insights/signals") {
      feedRequests.push({ pathname, params: new URLSearchParams(searchParams) });
      const unsupported = unsupportedQuery(searchParams, ["limit", "window_days"]);
      const limit = positiveInteger(searchParams.get("limit"), 10, MAX_LIMIT);
      const windowDays = positiveInteger(searchParams.get("window_days"), 30, MAX_WINDOW_DAYS);
      if (unsupported !== undefined || limit === null || windowDays === null) {
        sendError(res, 400, "invalid_parameter", "invalid_feed_query");
        return;
      }
      if (pathname.endsWith("/hot")) {
        send(res, 200, { ...FIXTURE_HOT_V1, window_days: windowDays, entries: FIXTURE_HOT_V1.entries.slice(0, limit) });
      } else {
        send(res, 200, {
          ...FIXTURE_SIGNALS_V1,
          window_days: windowDays,
          signals: FIXTURE_SIGNALS_V1.signals.slice(0, limit),
        });
      }
      return;
    }
    if (pathname === "/api/site/career-insights/daily") {
      feedRequests.push({ pathname, params: new URLSearchParams(searchParams) });
      const unsupported = unsupportedQuery(searchParams, []);
      if (unsupported !== undefined) {
        sendError(res, 400, "invalid_parameter", "invalid_feed_query");
        return;
      }
      send(res, 200, FIXTURE_DAILY_V1);
      return;
    }
    if (pathname === "/api/site/career-insights/policies") {
      policyRequests.push(new URLSearchParams(searchParams));
      const page = positiveInteger(searchParams.get("page"), 1, MAX_PAGE);
      const pageSize = positiveInteger(searchParams.get("page_size"), 20, MAX_PAGE_SIZE);
      const sourceKey = searchParams.get("source_key");
      const theme = searchParams.get("theme");
      if (page === null || pageSize === null) {
        sendError(res, 400, "invalid_parameter", "invalid_page");
        return;
      }
      if (sourceKey !== null && !POLICY_SOURCE_OPTIONS.some((option) => option.value === sourceKey)) {
        sendError(res, 400, "invalid_parameter", "unknown_source");
        return;
      }
      if (theme !== null && !Object.hasOwn(THEME_LABELS, theme)) {
        sendError(res, 400, "invalid_parameter", "unknown_theme");
        return;
      }
      const items = sourceKey === null
        ? FIXTURE_POLICY_LIST_V1.items
        : FIXTURE_POLICY_LIST_V1.items.filter((_, index) =>
            (POLICY_SOURCE_ITEM_INDEXES[sourceKey] ?? []).includes(index));
      send(res, 200, {
        ...FIXTURE_POLICY_LIST_V1,
        items,
        total: sourceKey === null ? FIXTURE_POLICY_LIST_V1.total : items.length,
        page,
        page_size: pageSize,
        filters: {
          page,
          page_size: pageSize,
          ...(sourceKey === null ? {} : { source_key: sourceKey }),
          ...(theme === null ? {} : { theme }),
        },
      });
      return;
    }

    const detailMatch = pathname.match(/^\/api\/site\/career-insights\/jobs\/([^/]+)$/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]);
      if (id === FIXTURE_JOB_DETAIL_V1.job.id) {
        send(res, 200, FIXTURE_JOB_DETAIL_V1);
      } else {
        sendError(res, 404, "not_found", "job_not_found");
      }
      return;
    }

    sendError(res, 404, "not_found", "route_not_found");
  } catch {
    sendError(res, 500, "internal_error", "fixture_server_error");
  }
});

fixtureServer.listen(PORT, HOST, () => {
  console.log(`Career Insights fixture API: http://${HOST}:${PORT}（联调样例，非真实数据）`);
});