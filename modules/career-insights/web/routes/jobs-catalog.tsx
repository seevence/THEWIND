import { isRouteErrorResponse, useLoaderData, useNavigation, useRouteError, type MetaFunction } from "react-router";
import type { LoaderArgs } from "@aihot/web/lib/route-types";
import type { Screen } from "@aihot/web/components/shell/screens";
import type { JobListResponseV1 } from "@aihot/career-insights/contracts";
import type { CareerCatalogResponseV1 } from "../../contracts/index.ts";
import { careerApiPath, loadCareerApi, parseDashboardFilters, serializeJobFilters } from "../api";
import { CATALOG_LIMIT, CATALOG_WINDOW_DAYS, JobsCatalogBoard } from "../components/JobsCatalogBoard";
import { CareerError, CareerLoading, CareerPending } from "../components/CareerStates";
import { JobStarButton } from "../components/JobStarButton";
import { careerJobsMeta } from "../seo";

export async function loader({ request }: LoaderArgs) {
  const search = new URL(request.url).searchParams;
  const filters = parseDashboardFilters(search);
  const [catalog, jobs] = await Promise.all([
    loadCareerApi<CareerCatalogResponseV1>(
      `${careerApiPath("/catalog")}?limit=${CATALOG_LIMIT}&window_days=${CATALOG_WINDOW_DAYS}`,
      request.signal,
    ),
    loadCareerApi<JobListResponseV1>(`${careerApiPath("/jobs")}?${serializeJobFilters(filters)}`, request.signal),
  ]);
  return { catalog, jobs, filters };
}

export function headers() {
  // 数据分钟级更新：允许浏览器与共享缓存 60 秒，别再让每个 career 页都 no-store。
  return { "Cache-Control": "public, s-maxage=60" };
}

export const handle: Screen = { tab: "jobs", name: "热门岗位" };

/**
 * 关键词只改这一页的结果视图，因此 canonical 固定指向不带查询的列表页，避免把每个搜索词都登记成
 * 独立页面；标题带关键词，读者与分享预览能看出这是搜索结果。标题/描述/canonical/ItemList/RSS 发现
 * 链接都在 web/seo.ts 的 careerJobsMeta 里。
 */
export const meta: MetaFunction<typeof loader> = ({ loaderData }) =>
  careerJobsMeta({ keyword: loaderData?.filters.q, jobs: loaderData?.jobs });

export const HydrateFallback = CareerLoading;

export function ErrorBoundary() {
  const error = useRouteError();
  return <CareerError status={isRouteErrorResponse(error) ? error.status : 500} />;
}

export default function JobsCatalogRoute() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  return (
    <>
      {navigation.state === "loading" && (
        <div className="mb-3">
          <CareerPending label="正在加载筛选结果…" />
        </div>
      )}
      <JobsCatalogBoard catalog={data.catalog} jobs={data.jobs} filters={data.filters} starButton={JobStarButton} />
    </>
  );
}