import { Fragment, createElement as h, type ReactElement } from "react";
import { Link } from "react-router";
import { buildPoliciesHref, type PolicyListResponse, type PolicyPageFilters } from "../policy.ts";
import { POLICY_SOURCE_OPTIONS, POLICY_SOURCE_TIER_LABELS, THEME_LABELS, policySourceLabel } from "../labels.ts";
import { CareerDate } from "../time.ts";

const CHIP_CLASS = "inline-flex h-11 items-center rounded-full border px-3 text-[12px] font-medium break-words sm:h-8";
const CHIP_ACTIVE_CLASS = `${CHIP_CLASS} border-accent bg-accent text-accent-contrast`;
const CHIP_IDLE_CLASS = `${CHIP_CLASS} border-line-strong text-ink-2`;

const THEME_OPTIONS = Object.entries(THEME_LABELS).map(([value, label]) => ({ value, label }));

function FilterChips({ label, options, active, hrefFor }: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string; count?: number }>;
  active?: string;
  hrefFor: (value?: string) => string;
}): ReactElement {
  return h(
    "div",
    { className: "flex flex-wrap items-baseline gap-x-2 gap-y-2", "data-filter-group": label },
    h("span", { className: "text-[12px] text-ink-4" }, label),
    h(
      Link,
      { to: hrefFor(undefined), "aria-current": active === undefined ? "page" : undefined, className: active === undefined ? CHIP_ACTIVE_CLASS : CHIP_IDLE_CLASS },
      "全部",
    ),
    ...options.map((option) =>
      h(
        Link,
        {
          key: option.value,
          to: hrefFor(option.value),
          "aria-current": active === option.value ? "page" : undefined,
          className: active === option.value ? CHIP_ACTIVE_CLASS : CHIP_IDLE_CLASS,
        },
        option.count === undefined ? option.label : `${option.label}（${option.count}）`,
      ),
    ),
  );
}

function PolicyRow({ policy }: { policy: PolicyListResponse["items"][number] }): ReactElement {
  return h(
    "li",
    { "data-policy-item": true, className: "px-4 py-4" },
    h(
      "a",
      {
        "data-policy-link": true,
        href: policy.official_url,
        target: "_blank",
        rel: "noopener noreferrer",
        className: "break-words text-[15px] font-semibold text-accent hover:underline",
      },
      policy.title,
    ),
    h(
      "div",
      { className: "mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3" },
      h("span", null, policy.issuer),
      h("span", null, "·"),
      h(CareerDate, { value: policy.published_at }),
      h("span", null, "·"),
      h("span", { "data-source-tier": policy.source_tier }, POLICY_SOURCE_TIER_LABELS[policy.source_tier] ?? policy.source_tier),
    ),
    policy.theme_ids.length === 0
      ? null
      : h(
          "div",
          { className: "mt-2 break-words text-[11px] text-ink-4" },
          `主题：${policy.theme_ids.map((themeId) => THEME_LABELS[themeId] ?? themeId).join("、")}`,
        ),
  );
}

export function PolicyList({ policies, filters }: { policies: PolicyListResponse; filters: PolicyPageFilters }): ReactElement {
  const hasFilters = filters.source_key !== undefined || filters.theme !== undefined;
  // 来源/主题选项优先用 API facets（count 为全量，不随筛选变化）。
  // facets 缺失时回退静态清单，兼容老 API/固件，避免筛选区空白。
  const sourceOptions: ReadonlyArray<{ value: string; label: string; count?: number }> = policies.facets === undefined
    ? POLICY_SOURCE_OPTIONS
    : policies.facets.sources.map((facet) => ({
        value: facet.source_key,
        label: policySourceLabel(facet.source_key),
        count: facet.count,
      }));
  const themeOptions: ReadonlyArray<{ value: string; label: string; count?: number }> = policies.facets === undefined
    ? THEME_OPTIONS
    : policies.facets.themes.map((facet) => ({
        value: facet.theme_id,
        label: THEME_LABELS[facet.theme_id] ?? facet.theme_id,
        count: facet.count,
      }));
  const sourcesEmpty = policies.facets !== undefined && policies.facets.sources.length === 0;
  const themesEmpty = policies.facets !== undefined && policies.facets.themes.length === 0;
  const outOfRange = policies.items.length === 0 && policies.total > 0;
  const hrefForPage = (target: number) => buildPoliciesHref({ ...filters, page: target, page_size: policies.page_size });

  return h(
    Fragment,
    null,
    h(
      "section",
      { "aria-labelledby": "policy-filters", className: "space-y-3 rounded-card border border-line bg-surface p-4" },
      h("h2", { id: "policy-filters", className: "text-[16px] font-semibold text-ink" }, "筛选政策"),
      sourcesEmpty
        ? h("p", { "data-filter-empty": "source", className: "text-[12px] text-ink-4" }, "暂无来源筛选选项")
        : h(FilterChips, {
            label: "来源",
            options: sourceOptions,
            active: filters.source_key,
            hrefFor: (sourceKey?: string) =>
              buildPoliciesHref({ page: 1, page_size: filters.page_size, theme: filters.theme, source_key: sourceKey }),
          }),
      themesEmpty
        ? h("p", { "data-filter-empty": "theme", className: "text-[12px] text-ink-4" }, "暂无主题筛选选项")
        : h(FilterChips, {
            label: "主题",
            options: themeOptions,
            active: filters.theme,
            hrefFor: (theme?: string) =>
              buildPoliciesHref({ page: 1, page_size: filters.page_size, source_key: filters.source_key, theme }),
          }),
    ),
    h(
      "section",
      { "aria-labelledby": "policy-list" },
      h(
        "div",
        { className: "flex flex-wrap items-baseline justify-between gap-2" },
        h("h2", { id: "policy-list", className: "text-[18px] font-semibold text-ink" }, "政策列表"),
        h("span", { className: "num text-[12px] text-ink-4" }, `共 ${policies.total} 条`),
      ),
      outOfRange
        ? h(
            "div",
            { className: "mt-3 rounded-card border border-line bg-surface p-6 text-center" },
            h("p", { role: "status", className: "text-[14px] text-ink-2" }, "当前页没有政策，可能已超出结果页数。"),
            h(
              Link,
              {
                to: hrefForPage(1),
                className: "mt-3 inline-flex h-11 items-center rounded-full border border-line-strong px-5 text-[13px] font-medium text-ink-2 sm:h-9",
              },
              "回到第 1 页",
            ),
          )
        : policies.total !== 0
        ? h(
            "ul",
            { className: "mt-3 divide-y divide-line-soft overflow-hidden rounded-card border border-line bg-surface" },
            ...policies.items.map((policy) => h(PolicyRow, { key: policy.policy_item_id, policy })),
          )
        : h(
            "section",
            { role: "status", className: "mt-3 rounded-card border border-line bg-surface px-5 py-8 text-center" },
            h("h3", { className: "text-[16px] font-semibold text-ink" }, "当前筛选下暂无政策"),
            h("p", { className: "mt-2 text-[13px] leading-relaxed text-ink-3" }, "换个来源或主题试试；这不代表没有相关政策。"),
            hasFilters
              ? h(
                  Link,
                  {
                    to: buildPoliciesHref({ page: 1, page_size: filters.page_size }),
                    className: "mt-4 inline-flex h-11 items-center rounded-full border border-line-strong px-5 text-[13px] font-medium text-ink-2 sm:h-9",
                  },
                  "清除筛选",
                )
              : null,
          ),
    ),
  );
}