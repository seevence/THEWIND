import { Link, isRouteErrorResponse, useLoaderData, useNavigation, useRouteError } from "react-router";
import type { LoaderArgs } from "@aihot/web/lib/route-types";
import { loadPolicies } from "../api";
import {
  buildPoliciesHref,
  parsePolicyFiltersOrThrow,
  policyApiPath,
  type PolicyListResponse,
  type PolicyPageFilters,
} from "../policy";
import { Pagination } from "../components/Pagination";
import { PolicyList } from "../components/PolicyList";
import { CareerError, CareerLoading, CareerPending, FixtureNotice } from "../components/CareerStates";
import { careerPoliciesMeta } from "../seo";

const POLICY_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;


export function PoliciesView({ policies, filters }: { policies: PolicyListResponse; filters: PolicyPageFilters }) {
  return (
    <div className="space-y-6 pb-10 pt-3">
      <header>
        <h1 data-page-title="" className="text-[24px] font-semibold text-ink">政策文件</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-3">政策数据来自政府公开来源，共 {policies.total} 条。</p>
      </header>

      {policies.data_origin === "synthetic_fixture" && <FixtureNotice />}

      <PolicyList policies={policies} filters={filters} />

      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="text-ink-4">每页</span>
        {POLICY_PAGE_SIZE_OPTIONS.map((size) => (
          <Link
            key={size}
            to={buildPoliciesHref({ ...filters, page: 1, page_size: size })}
            aria-current={size === policies.page_size ? "true" : undefined}
            className={`rounded-control px-2 py-1 ${
              size === policies.page_size
                ? "bg-accent font-medium text-accent-contrast"
                : "border border-line text-ink-2 hover:bg-bg-sunk"
            }`}
          >
            {size} 条
          </Link>
        ))}
      </div>

      {policies.items.length > 0 && (
        <Pagination
          page={policies.page}
          pageSize={policies.page_size}
          total={policies.total}
          ariaLabel="政策分页"
          hrefFor={(target) => buildPoliciesHref({ ...filters, page: target, page_size: policies.page_size })}
        />
      )}
    </div>
  );
}

export async function loader({ request }: LoaderArgs) {
  const filters = parsePolicyFiltersOrThrow(new URL(request.url).searchParams);
  const policies = await loadPolicies(policyApiPath(filters), request.signal);
  return { policies, filters };
}

export function headers() {
  // 数据分钟级更新：允许浏览器与共享缓存 60 秒，别再让每个 career 页都 no-store。
  return { "Cache-Control": "public, s-maxage=60" };
}

/** 标题/描述/canonical/ItemList/RSS 发现链接见 web/seo.ts 的 careerPoliciesMeta；筛选是浏览视图，canonical 回到政策页本身。 */
export function meta({ loaderData }: { loaderData?: Awaited<ReturnType<typeof loader>> }) {
  return careerPoliciesMeta(loaderData?.policies);
}

export const HydrateFallback = CareerLoading;

export function ErrorBoundary() {
  const error = useRouteError();
  return <CareerError status={isRouteErrorResponse(error) ? error.status : 500} />;
}

export default function CareerPoliciesRoute() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const pending = navigation.state === "loading";
  return (
    <>
      {pending && (
        <div className="mb-3">
          <CareerPending label="正在加载政策结果…" />
        </div>
      )}
      <PoliciesView policies={data.policies} filters={data.filters} />
    </>
  );
}