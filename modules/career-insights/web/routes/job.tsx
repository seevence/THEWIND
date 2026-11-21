import { data, isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";
import type { LoaderArgs } from "@aihot/web/lib/route-types";
import { pageMeta } from "@aihot/web/lib/seo";
import type { JobDetailResponseV1, ObservationPublicV1 } from "@aihot/career-insights/contracts";
import { careerApiPath, loadCareerApi } from "../api";
import { safeBackHref } from "../filters";
import { CareerError, CareerLoading, FixtureNotice, SingleSnapshotNotice } from "../components/CareerStates";
import { JobDetail } from "../components/JobDetail";
import { jobMeta } from "../seo";
import { CareerTime } from "../time";

export async function loader({ params, request }: LoaderArgs) {
  if (!params.id) throw data({ message: "not_found" }, { status: 404 });
  const back = new URL(request.url).searchParams.get("back");
  const detail = await loadCareerApi<JobDetailResponseV1>(careerApiPath(`/jobs/${encodeURIComponent(params.id)}`), request.signal);
  return { detail, backHref: safeBackHref(back) };
}

export function headers() {
  // 数据分钟级更新：允许浏览器与共享缓存 60 秒，别再让每个 career 页都 no-store。
  return { "Cache-Control": "public, s-maxage=60" };
}

/** 职位名 + 库里的公司/城市/职族等事实（见 web/seo.ts），canonical 带 id；加载失败时不索引。 */
export function meta({ loaderData }: { loaderData?: Awaited<ReturnType<typeof loader>> }) {
  if (!loaderData) return pageMeta({ title: "职位详情", path: "/career-insights/jobs", noindex: true });
  return jobMeta(loaderData.detail);
}

export const HydrateFallback = CareerLoading;

export function ErrorBoundary() {
  const error = useRouteError();
  return <CareerError status={isRouteErrorResponse(error) ? error.status : 500} />;
}

function observedAtMs(observation: ObservationPublicV1): number {
  const ms = new Date(observation.observed_at).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

// 同一内容多次被抓取时只展示最新一条，其余次数折叠成一行说明。
function groupObservations(observations: ObservationPublicV1[]): { latest: ObservationPublicV1; count: number }[] {
  const groups = new Map<string, { latest: ObservationPublicV1; count: number }>();
  for (const observation of observations) {
    const existing = groups.get(observation.content_hash);
    if (!existing) {
      groups.set(observation.content_hash, { latest: observation, count: 1 });
      continue;
    }
    existing.count += 1;
    if (observedAtMs(observation) > observedAtMs(existing.latest)) existing.latest = observation;
  }
  return [...groups.values()].sort((a, b) => observedAtMs(b.latest) - observedAtMs(a.latest));
}

export default function CareerJobRoute() {
  const { detail, backHref } = useLoaderData<typeof loader>();
  const { job, observations } = detail;
  const groups = groupObservations(observations);

  return (
    <article className="space-y-6 pb-10 pt-3">
      <JobDetail job={job} backHref={backHref} />
      {detail.data_origin === "synthetic_fixture" && <FixtureNotice />}

      <p className="rounded-card border border-line bg-bg-sunk px-4 py-3 text-[13px] leading-relaxed text-ink-3">{detail.notice}</p>

      <section aria-labelledby="job-observations">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="job-observations" className="text-[17px] font-semibold text-ink">观测记录</h2>
          {observations.length > 0 && (
            <span className="text-[12px] text-ink-4">共 {observations.length} 条观测，{groups.length} 个不同内容</span>
          )}
        </div>
        {observations.length > 0 && groups.length === 1 && <div className="mt-3"><SingleSnapshotNotice /></div>}
        {observations.length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-3">暂无观测记录。</p>
        ) : (
          <ol className="mt-3 space-y-3">
            {groups.map((group) => (
              <li key={group.latest.content_hash} className="rounded-card border border-line bg-surface p-4">
                <CareerTime value={group.latest.observed_at} className="text-[12px] text-ink-4" />
                <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{group.latest.evidence_excerpt}</p>
                <a href={group.latest.source_url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex text-[12px] text-accent">查看观测来源</a>
                <div className="mono mt-2 break-all text-[11px] text-ink-4">{group.latest.content_hash} · {group.latest.collector_version}</div>
                {group.count > 1 && (
                  <p className="mt-2 text-[11px] text-ink-4">同一内容另有 {group.count - 1} 次重复观测</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}
