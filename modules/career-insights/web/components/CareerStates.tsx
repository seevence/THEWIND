import { Link, useRevalidator } from "react-router";

export function FixtureNotice() {
  return (
    <div role="note" className="rounded-card border border-amber-300 bg-amber-50 px-4 py-3 text-[13px] font-medium text-amber-900 break-words">
      联调样例（非真实数据）
    </div>
  );
}

export function CareerLoading() {
  return (
    <div role="status" aria-live="polite" className="py-24 text-center text-[14px] text-ink-3">
      正在加载职业洞察…
    </div>
  );
}

/** 导航中的行内 pending 提示：保留已渲染内容，只提示正在加载新结果。 */
export function CareerPending({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="rounded-card border border-line bg-bg-sunk px-4 py-2 text-[13px] text-ink-3">
      {label}
    </div>
  );
}

export function CareerEmpty() {
  return (
    <section role="status" className="rounded-card border border-line bg-surface px-5 py-8 text-center">
      <h2 className="text-[16px] font-semibold text-ink">暂无职位数据</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-3">当前查询没有职位记录；这不代表市场没有岗位。</p>
    </section>
  );
}

export function SingleSnapshotNotice() {
  return (
    <div role="note" className="rounded-card border border-line bg-bg-sunk px-4 py-3 text-[13px] leading-relaxed text-ink-3 break-words">
      当前仅有单快照，新增岗位与变化趋势数据不足，不作趋势推断。
    </div>
  );
}

export function CareerError({ status = 500 }: { status?: number }) {
  const revalidator = useRevalidator();
  const unavailable = status === 503;
  const notFound = status === 404;
  const badRequest = status === 400;
  const title = unavailable ? "数据尚未就绪" : notFound ? "职位不存在" : badRequest ? "请求参数有误" : "暂时无法加载";
  const description = unavailable
    ? "正式数据服务尚未接入或暂时不可用，请稍后重试。"
    : notFound
      ? "链接可能有误，或者该职位当前不可见。"
      : badRequest
        ? "请检查查询条件后重试。"
        : "职业洞察 API 请求失败，请稍后重试。";

  return (
    <div role="alert" className="mx-auto max-w-md px-4 py-16 text-center sm:py-24">
      <div className="mono text-[12px] text-ink-4">{status}</div>
      <h1 className="mt-2 text-[20px] font-bold text-ink break-words">{title}</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-3 break-words">{description}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        {!notFound && (
          <button
            type="button"
            disabled={revalidator.state === "loading"}
            onClick={() => void revalidator.revalidate()}
            className="h-10 rounded-full bg-accent px-5 text-[13px] font-medium text-accent-contrast disabled:opacity-60"
          >
            {revalidator.state === "loading" ? "正在重试…" : "重试"}
          </button>
        )}
        <Link to="/career-insights" className="inline-flex h-10 items-center rounded-full border border-line-strong px-5 text-[13px] font-medium text-ink-2">
          返回看板
        </Link>
      </div>
    </div>
  );
}
