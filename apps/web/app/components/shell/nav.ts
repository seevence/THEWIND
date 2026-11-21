// Site navigation in one place: the desktop sidebar's sections and the phone tab bar's tabs, the engine's
// and the site's modules'.
import type { ReactNode } from "react";
import { NAV, subjectAfter, withSubject } from "@aihot/site";
import { webModules } from "../../site-modules";
import {
  IconBolt, IconBookmark, IconChart, IconDoc, IconFlame, IconGrid, IconHeart, IconHistory, IconList, IconMessage, IconPlug,
} from "../icons";

export interface NavItem {
  to: string;
  label: string;
  icon: (p: { size?: number }) => ReactNode;
  /** Match the path exactly (the home page). */
  end?: boolean;
  /** Other pages the entry stands for: they and the pages under them light it too. */
  covers?: string[];
  /** Shows the unread dot while the changelog has news. */
  changelog?: boolean;
}

/**
 * The main navigation: 首页, 热门岗位, 就业热点, 职业洞察 and 就业日报. 全部 and 主题 are listed but
 * NAV.hidden keeps them out of the way in unless the site puts them back; a hidden entry still opens.
 */
const SECTIONS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "内容",
    items: [
      { to: "/", label: "首页", icon: IconBolt, end: true },
      { to: "/career-insights/jobs", label: "热门岗位", icon: IconList },
      { to: "/hot", label: "就业热点", icon: IconFlame },
      { to: "/career-insights", label: "职业洞察", icon: IconChart },
      { to: "/daily", label: withSubject("日报"), icon: IconDoc, covers: ["/weekly", "/monthly"] },
      { to: "/all", label: subjectAfter("全部", "动态"), icon: IconList },
      { to: "/topics", label: "主题", icon: IconGrid },
    ],
  },
  {
    title: "更多",
    items: [
      { to: "/agent", label: "Agent 接入", icon: IconPlug },
      { to: "/about", label: "关于", icon: IconHeart },
      { to: "/changelog", label: "更新日志", icon: IconHistory, changelog: true },
      { to: "/feedback", label: "反馈", icon: IconMessage },
      // 收藏放在侧栏最下面：它是个人入口，不参与内容浏览的阅读顺序。
      { to: "/starred", label: "收藏", icon: IconBookmark },
    ],
  },
];

/** Whether an engine page is a way in from the navigation (site.ts NAV.hidden); a hidden page still opens. */
export const inNav = (to: string) => !(NAV.hidden as readonly string[]).includes(to);

const UP = {
  "/hot": { name: "就业热点", back: "就业热点", tab: "hot" },
  "/topics": { name: "主题", back: "全部主题", tab: "me" },
} as const;

/**
 * Where pages under a navigation entry lead back up to: the entry, or 首页 in its place while the site hides
 * it. `name` is for breadcrumbs and desktop back links (热点榜), `back` for the phone bar (热点), `tab` the
 * phone tab it sits under, `crumbs` its breadcrumb after the site's home.
 */
export function navUp(entry: keyof typeof UP): { to: string; name: string; back: string; tab: TabKey; crumbs: Array<{ name: string; path: string }> } {
  if (!inNav(entry)) return { to: "/", name: "首页", back: "首页", tab: "featured", crumbs: [] };
  return { to: entry, ...UP[entry], crumbs: [{ name: UP[entry].name, path: entry }] };
}

/**
 * The sidebar: the engine's sections with the modules' between 内容 and 更多; a module naming a section
 * that is already there adds to it.
 */
export function sidebar(): Array<{ title: string; items: NavItem[] }> {
  const [content, ...rest] = SECTIONS;
  const more = rest.pop()!;
  const sections = [content!, ...rest].map((s) => ({ ...s, items: s.items.filter((i) => inNav(i.to)) }));
  for (const m of webModules()) {
    if (!m.sidebar) continue;
    const section = sections.find((s) => s.title === m.sidebar!.section);
    if (section) section.items.push(...m.sidebar.items);
    else sections.push({ title: m.sidebar.section, items: [...m.sidebar.items] });
  }
  return [...sections, more];
}

/** A sidebar entry is lit on its pages and the ones it covers (日报 also covers weekly and monthly reports). */
export function sidebarIsActive(item: Pick<NavItem, "to" | "end" | "covers">, pathname: string): boolean {
  if (item.end) return pathname === item.to;
  return [item.to, ...(item.covers ?? [])].some((to) => pathname === to || pathname.startsWith(`${to}/`));
}

/**
 * The deepest entry a path belongs to: a page can sit under more than one entry of its section (a module's
 * list and a detail page under it), and only the most specific one is lit.
 */
export function activeSidebarItem(items: readonly NavItem[], pathname: string): NavItem | null {
  let lit: NavItem | null = null;
  for (const item of items) {
    if (sidebarIsActive(item, pathname) && (!lit || item.to.length > lit.to.length)) lit = item;
  }
  return lit;
}

/**
 * The phone tab bar: the main navigation's five entries leave four tabs (首页, 岗位, 洞察, 收藏) with 我的's
 * pages opening from 收藏, and 日报 (a desktop entry) is reached from elsewhere; 热点 joins only when the site
 * puts it back in the navigation. Which tab a page sits under is declared by the page itself
 * (components/shell/screens.ts).
 */
export type TabKey =
  | "featured"
  | "jobs"
  | "insights"
  | "hot"
  | "daily"
  | "me"
  // A module's tab.
  | (string & {});

export interface Tab {
  key: TabKey;
  to: string;
  label: string;
  icon: (p: { size?: number }) => ReactNode;
  /** As NavItem.covers. */
  covers?: string[];
  changelog?: boolean;
}

const ENGINE_TABS: Tab[] = [
  { key: "featured", to: "/", label: "首页", icon: IconBolt },
  { key: "jobs", to: "/career-insights/jobs", label: "岗位", icon: IconList },
  { key: "insights", to: "/career-insights", label: "洞察", icon: IconChart },
  { key: "hot", to: "/hot", label: "热点", icon: IconFlame },

  { key: "me", to: "/starred", label: "收藏", icon: IconBookmark, changelog: true },
];

/** The tab bar: the engine's, the modules' before 收藏. */
export function tabs(): Tab[] {
  return [...ENGINE_TABS.slice(0, -1).filter((t) => inNav(t.to)), ...webModules().flatMap((m) => m.tabs ?? []), ENGINE_TABS.at(-1)!];
}

/**
 * The rail that stands in for the sidebar on narrow desktops (unfolded foldables, tablets upright): the
 * tabs, with 全部 after 首页 since desktop pages have no 首页 | 全部 switch.
 */
export function rail(): Tab[] {
  const all = tabs();
  if (!inNav("/all")) return all;
  const at = all.findIndex((t) => t.key === "featured") + 1;
  return [...all.slice(0, at), { key: "all", to: "/all", label: "全部", icon: IconList }, ...all.slice(at)];
}

/** A rail entry is lit on its pages; 收藏 also on the pages that sit under it on phones. */
export function railIsActive(tab: Tab, pathname: string, screenTab: TabKey | undefined): boolean {
  if (tab.key === "me") return pathname === tab.to || screenTab === "me";
  return sidebarIsActive({ to: tab.to, end: tab.to === "/", covers: tab.covers }, pathname);
}
