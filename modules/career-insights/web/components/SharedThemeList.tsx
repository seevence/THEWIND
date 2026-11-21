import { Link } from "react-router";
import type { SharedThemeV1 } from "@aihot/career-insights/contracts";

const CORRELATION_DISCLAIMER = "只表示政策方向与招聘需求的呼应，不表示因果关系。";

export function SharedThemeList({ themes }: { themes: SharedThemeV1[] }) {
  if (themes.length === 0) return null;

  return (
    <section aria-labelledby="shared-themes">
      <h2 id="shared-themes" className="text-[17px] font-semibold text-ink">政策—岗位共享主题</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{CORRELATION_DISCLAIMER}</p>

      <ul className="mt-3 space-y-3">
        {themes.map((theme) => (
          <li key={theme.theme_id} data-theme-id={theme.theme_id} className="rounded-card border border-line bg-surface p-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-[15px] font-semibold text-ink">{theme.label}</h3>
              <span className="text-[12px] text-ink-3">政策 {theme.policy_count}</span>
              <span className="text-[12px] text-ink-3">岗位 {theme.job_count}</span>
            </div>

            <details className="group mt-3">
              <summary className="cursor-pointer text-[13px] font-medium text-accent">两侧证据</summary>

              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="text-[12px] font-semibold text-ink-4">政策侧</div>
                  {theme.policies.length === 0 ? (
                    <p className="mt-2 text-[13px] text-ink-3">暂无证据</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {theme.policies.map((policy) => (
                        <li key={policy.policy_item_id} className="rounded-card border border-line bg-bg-sunk p-3">
                          <a
                            href={policy.official_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="break-words text-[13px] font-medium text-accent hover:underline"
                          >
                            {policy.title}
                          </a>
                          <div className="mt-1 flex flex-wrap gap-x-2 text-[12px] text-ink-3">
                            <span>{policy.issuer}</span>
                            <span>·</span>
                            <span>{policy.published_at}</span>
                            {policy.source_tier && <span>· {policy.source_tier}</span>}
                          </div>
                          <p className="mt-2 break-words text-[13px] leading-relaxed text-ink-2">{policy.evidence_excerpt}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <div className="text-[12px] font-semibold text-ink-4">职位侧</div>
                  {theme.jobs.length === 0 ? (
                    <p className="mt-2 text-[13px] text-ink-3">暂无证据</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {theme.jobs.map((job) => (
                        <li key={job.id} className="rounded-card border border-line bg-bg-sunk p-3">
                          <Link
                            to={`/career-insights/jobs/${encodeURIComponent(job.id)}`}
                            className="break-words text-[13px] font-medium text-accent hover:underline"
                          >
                            {job.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}