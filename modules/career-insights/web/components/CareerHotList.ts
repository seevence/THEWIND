import { createElement as h, type ReactElement } from "react";
import { Link } from "react-router";
import type { CareerHotEntryV1 } from "../../contracts/index.ts";
import { publishedAtText, topRoleFamilies } from "../feeds.ts";
import { ROLE_FAMILY_LABELS } from "../labels.ts";

const ROW_CLASS = "grid grid-cols-[28px_minmax(0,1fr)] items-start gap-x-3 px-4 py-3.5 sm:px-5";

function FamilyChips({ entry }: { entry: CareerHotEntryV1 }): ReactElement | null {
  const families = topRoleFamilies(entry);
  if (families.length === 0) return null;
  return h(
    "div",
    { className: "mt-2 flex flex-wrap gap-1.5" },
    ...families.map((family) =>
      h(
        "span",
        { key: family.role_family, "data-hot-family": family.role_family, className: "inline-flex h-6 items-center rounded-full border border-line-strong px-2.5 text-[11.5px] text-ink-2" },
        `${ROLE_FAMILY_LABELS[family.role_family]} ${family.count}`,
      ),
    ),
  );
}

function HotRow({ entry, rank }: { entry: CareerHotEntryV1; rank: number }): ReactElement {
  return h(
    "li",
    { "data-hot-entry": "", className: ROW_CLASS },
    h("span", { className: "mono text-[15px] font-semibold leading-[24px] text-ink-4" }, String(rank).padStart(2, "0")),
    h(
      "div",
      { className: "min-w-0" },
      h(
        "div",
        { className: "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1" },
        h("span", { "data-hot-company": entry.company, className: "text-[15px] font-semibold text-ink break-words" }, entry.company),
        h(
          "span",
          { className: "text-[13px] text-ink-3 whitespace-nowrap" },
          h("span", { "data-hot-job-count": String(entry.job_count), className: "num text-[15px] font-semibold text-ink" }, String(entry.job_count)),
          " 个岗位",
        ),
      ),
      h(FamilyChips, { entry }),
      h(
        "p",
        { className: "mt-1.5 text-[12px] text-ink-4" },
        "最近发布 ",
        h("span", { "data-hot-latest": entry.latest_published_at ?? "", className: "num" }, publishedAtText(entry.latest_published_at)),
      ),
    ),
  );
}

export function CareerHotList({ entries }: { entries: readonly CareerHotEntryV1[] }): ReactElement {
  return h(
    "section",
    { "aria-labelledby": "career-hot" },
    h("div", { className: "mb-3 flex items-baseline justify-between px-1" },
      h("h2", { id: "career-hot", className: "text-[16px] font-semibold text-ink" }, "企业招聘热度榜"),
      entries.length > 0 ? h("span", { className: "text-[12px] text-ink-4" }, `共 ${entries.length} 家`) : null,
    ),
    entries.length === 0
      ? h(
          "div",
          { "data-hot-empty": "", className: "card rounded-sheet px-6 py-14 text-center" },
          h("p", { className: "text-[15px] font-semibold text-ink-2" }, "暂无企业招聘数据"),
          h(
            "p",
            { className: "mt-1.5 text-[13px] leading-relaxed text-ink-4" },
            "本站内容暂未接入，可先查看",
            h(Link, { to: "/career-insights", className: "font-medium text-accent hover:underline" }, "就业趋势洞察"),
            "。",
          ),
        )
      : h(
          "ol",
          { className: "card divide-y divide-line-soft overflow-hidden" },
          ...entries.map((entry, index) => h(HotRow, { key: entry.company, entry, rank: index + 1 })),
        ),
  );
}