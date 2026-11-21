// The search overlay's "在岗位中搜索" shortcut: the same query, encoded, on the jobs page.
// Pure and free of React so it can be tested without a browser (the overlay itself is phone-only).
export function jobsSearchHref(keyword: string): string | null {
  const trimmed = keyword.trim();
  return trimmed === "" ? null : `/career-insights/jobs?q=${encodeURIComponent(trimmed)}`;
}
