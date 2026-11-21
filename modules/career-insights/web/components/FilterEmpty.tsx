import { Link } from "react-router";

export function FilterEmpty({ hint }: { hint?: string }) {
  return (
    <section className="rounded-card border border-line bg-surface px-5 py-8 text-center">
      <div role="status">
        <h2 className="text-[16px] font-semibold text-ink">没有符合条件的职位</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">当前筛选条件下没有职位记录；这不代表市场没有岗位。</p>
        {hint !== undefined && <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{hint}</p>}
      </div>
      <Link to="/career-insights" className="mt-4 inline-flex h-9 items-center rounded-full border border-line-strong px-5 text-[13px] font-medium text-ink-2">
        清除筛选
      </Link>
    </section>
  );
}
