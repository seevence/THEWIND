import { isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";
import type { LoaderArgs } from "@aihot/web/lib/route-types";
import type { Screen } from "@aihot/web/components/shell/screens";
import type { SummaryResponseV1 } from "@aihot/career-insights/contracts";
import { API_BASE_URL } from "@aihot/web/lib/api.server";
import { careerApiPath, loadCareerApi } from "../api";
import { loadCareerSignals } from "../feeds.server";
import type { CareerBriefV1, CareerCatalogResponseV1 } from "../../contracts/index.ts";
import { CareerInsightsBoard } from "../components/CareerInsightsBoard";
import { CareerError, CareerLoading } from "../components/CareerStates";
import { careerDashboardMeta } from "../seo";

const CATALOG_LIMIT = 10;
const CATALOG_WINDOW_DAYS = 30;

/** 任一接口失败只让对应区块显示“暂时不可用”，不整页失败。 */
function degrade<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  return promise.catch((error: unknown) => {
    if (signal.aborted) throw error;
    return null;
  });
}

/** 离线研判无缓存时 API 返回 204；这里把 204 与请求失败都收敛为 null，由页面显示“继续积累观测”。 */
async function loadCareerBrief(signal: AbortSignal): Promise<CareerBriefV1 | null> {
  try {
    const response = await fetch(`${API_BASE_URL}${careerApiPath("/brief")}`, {
      headers: { accept: "application/json", "x-aihot-ssr": "1" },
      signal,
    });
    if (response.status === 204) return null;
    if (!response.ok) return null;
    return (await response.json()) as CareerBriefV1;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

export async function loader({ request }: LoaderArgs) {
  const { signal } = request;
  const [summary, catalog, signals, brief] = await Promise.all([
    degrade(loadCareerApi<SummaryResponseV1>(careerApiPath("/summary"), signal), signal),
    degrade(
      loadCareerApi<CareerCatalogResponseV1>(`${careerApiPath("/catalog")}?limit=${CATALOG_LIMIT}&window_days=${CATALOG_WINDOW_DAYS}`, signal),
      signal,
    ),
    degrade(loadCareerSignals(signal), signal),
    loadCareerBrief(signal),
  ]);
  return { summary, catalog, signals, brief };
}

export function headers() {
  // 数据分钟级更新：允许浏览器与共享缓存 60 秒，别再让每个 career 页都 no-store。
  return { "Cache-Control": "public, s-maxage=60" };
}

export const handle: Screen = { tab: "insights", name: "职业洞察" };

/** 标题/描述/canonical 见 web/seo.ts；联调样例（虚构数据）不索引。 */
export function meta({ loaderData }: { loaderData?: Awaited<ReturnType<typeof loader>> }) {
  return careerDashboardMeta(loaderData?.summary?.data_origin);
}

export const HydrateFallback = CareerLoading;

export function ErrorBoundary() {
  const error = useRouteError();
  return <CareerError status={isRouteErrorResponse(error) ? error.status : 500} />;
}

export default function CareerDashboardRoute() {
  const data = useLoaderData<typeof loader>();
  return <CareerInsightsBoard summary={data.summary} catalog={data.catalog} signals={data.signals} brief={data.brief} />;
}