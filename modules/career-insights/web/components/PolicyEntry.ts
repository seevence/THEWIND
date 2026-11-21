import { createElement as h, type ReactElement } from "react";
import { Link } from "react-router";

export const POLICY_ENTRY_LABEL = "政策文件";

/** 政策列表页的地址；入口不带筛选参数，进去看默认的第一页。 */
export function buildPolicyEntryHref(): string {
  return "/career-insights/policies";
}

export function PolicyEntry(): ReactElement {
  return h(
    "section",
    { "aria-labelledby": "career-policies", className: "rounded-card border border-line bg-surface p-4" },
    h("h2", { id: "career-policies", className: "text-[16px] font-semibold text-ink" }, POLICY_ENTRY_LABEL),
    h("p", { className: "mt-1 text-[12px] text-ink-3 break-words" }, "政府公开发布的政策文件与原文链接。"),
    h(
      Link,
      {
        to: buildPolicyEntryHref(),
        "aria-label": "查看政策文件",
        className: "mt-3 inline-flex h-9 items-center rounded-full border border-line-strong px-4 text-[13px] font-medium text-ink-2",
      },
      POLICY_ENTRY_LABEL,
    ),
  );
}