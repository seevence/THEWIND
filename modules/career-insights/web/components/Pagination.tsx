import { Link, useSearchParams } from "react-router";
import { buildJobsHref, parseDashboardFilters } from "../filters";

const ITEM_CLASS = "inline-flex h-10 min-w-10 items-center justify-center rounded-control px-2 text-[13px] sm:h-8 sm:min-w-8";

function pageNumbers(current: number, totalPages: number): Array<number | "gap"> {
  const numbers = new Set<number>([1, totalPages, current - 1, current, current + 1]);
  const sorted = [...numbers].filter((page) => page >= 1 && page <= totalPages).sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  for (const page of sorted) {
    const previous = out[out.length - 1];
    if (typeof previous === "number" && page - previous > 1) out.push("gap");
    out.push(page);
  }
  return out;
}

export function Pagination({ page, pageSize, total, hrefFor, ariaLabel = "职位分页" }: {
  page: number;
  pageSize: number;
  total: number;
  /** 政策等其他列表换页时的地址；缺省按职位筛选生成。 */
  hrefFor?: (target: number) => string;
  ariaLabel?: string;
}) {
  const [searchParams] = useSearchParams();
  const filters = parseDashboardFilters(searchParams);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);

  const hrefForPage = hrefFor ?? ((target: number) => buildJobsHref({ ...filters, page: target, page_size: pageSize }));

  return (
    <nav aria-label={ariaLabel} className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <span aria-current="page" className="num whitespace-nowrap text-[12px] text-ink-4">第 {current} / {totalPages} 页 · 共 {total} 条</span>
      <div className="flex flex-wrap items-center gap-1">
        {current > 1 ? (
          <Link to={hrefForPage(current - 1)} className={`${ITEM_CLASS} whitespace-nowrap border border-line text-ink-2 hover:bg-bg-sunk`}>
            上一页
          </Link>
        ) : (
          <span aria-disabled="true" className={`${ITEM_CLASS} whitespace-nowrap border border-line text-ink-4 opacity-60`}>上一页</span>
        )}

        <div className="hidden items-center gap-1 sm:flex">
          {pageNumbers(current, totalPages).map((item, index) =>
            item === "gap" ? (
              <span key={`gap-${index}`} className="px-1 text-[12px] text-ink-4">…</span>
            ) : item === current ? (
              <span key={item} className={`${ITEM_CLASS} bg-accent font-medium text-accent-contrast`}>
                {item}
              </span>
            ) : (
              <Link key={item} to={hrefForPage(item)} className={`${ITEM_CLASS} border border-line text-ink-2 hover:bg-bg-sunk`}>
                {item}
              </Link>
            ),
          )}
        </div>

        {current < totalPages ? (
          <Link to={hrefForPage(current + 1)} className={`${ITEM_CLASS} whitespace-nowrap border border-line text-ink-2 hover:bg-bg-sunk`}>
            下一页
          </Link>
        ) : (
          <span aria-disabled="true" className={`${ITEM_CLASS} whitespace-nowrap border border-line text-ink-4 opacity-60`}>下一页</span>
        )}
      </div>
    </nav>
  );
}
