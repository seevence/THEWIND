// 职业岗位的本地收藏：数据只存在这个浏览器里，和文章收藏（apps/web/app/lib/local-state.ts）各存各的 key。
// 岗位下架后收藏仍要显示，所以保存时快照标题、公司等字段；模块不能反向 import apps/web，
// 因此存储与 hook 都放在这里，/starred 页与岗位 UI 从模块导入。存储失败静默降级，服务端渲染不读 storage。
import { useSyncExternalStore } from "react";
import { beijingDate } from "@aihot/contracts/time";
import type { RoleFamily } from "@aihot/career-insights/contracts";

/** 与文章收藏的 `aihot-starred-items` 分开：两件事的数量上限与字段都不同。 */
export const STARRED_JOBS_KEY = "aihot-starred-jobs";
/** 岗位收藏只保留最近的一批，避免 localStorage 里无限增长。 */
export const STARRED_JOBS_LIMIT = 200;

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
const ROLE_FAMILIES: ReadonlySet<string> = new Set<RoleFamily>([
  "ai_algorithm",
  "ai_application_development",
  "data",
  "ai_product_operations",
  "unknown",
]);

/** 收藏时留下的岗位快照：字段够在 `/starred` 里认出岗位并链回详情页。 */
export interface LocalStarredJob {
  id: string;
  title: string;
  company: string;
  roleFamily?: RoleFamily;
  locations?: string[];
  savedAt: string;
}

// 只声明用到的浏览器存储能力：本模块的 tsconfig 没有 DOM lib，standalone 测试也注入普通对象。
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface StorageEventLike {
  key: string | null;
  storageArea?: unknown;
}
interface WindowLike {
  localStorage?: StorageLike;
  addEventListener(type: "storage", listener: (event: StorageEventLike) => void): void;
  removeEventListener(type: "storage", listener: (event: StorageEventLike) => void): void;
}

function browserWindow(): WindowLike | null {
  try {
    return (globalThis as { window?: WindowLike }).window ?? null;
  } catch {
    return null;
  }
}

/** 能否读到 localStorage 由浏览器决定：隐私模式或禁用存储时返回 null，调用方按空数据处理。 */
function storage(): StorageLike | null {
  try {
    const fromGlobal = (globalThis as { localStorage?: StorageLike }).localStorage;
    return fromGlobal ?? browserWindow()?.localStorage ?? null;
  } catch {
    return null;
  }
}

// 同一标签页里由本模块通知，其它标签页由 storage 事件通知；缓存保证 useSyncExternalStore 的快照引用稳定。
let cached: LocalStarredJob[] | null = null;
let cachedIds: Set<string> | null = null;
const listeners = new Set<() => void>();
let subscribers = 0;

function resetCache() {
  cached = null;
  cachedIds = null;
}

function emit() {
  for (const listener of listeners) listener();
}

function invalidate() {
  resetCache();
  emit();
}

function onStorage(event: StorageEventLike) {
  if (event.key !== null && event.key !== STARRED_JOBS_KEY) return;
  // 别的存储区（例如 sessionStorage）的变更不影响岗位收藏。
  if (event.storageArea && event.storageArea !== storage()) return;
  invalidate();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (subscribers++ === 0) browserWindow()?.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (--subscribers === 0) browserWindow()?.removeEventListener("storage", onStorage);
  };
}

/** 收藏变化时调用 `listener`（本标签页与其它标签页都算），给 React 之外的代码用；返回退订函数。 */
export function watchStarredJobs(listener: () => void): () => void {
  return subscribe(listener);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 能解析的日期仍可能在换成北京时区显示时溢出（如 +275760-09-13），收藏页的 fullDateTime 会抛错；
// 和文章收藏（apps/web/app/lib/local-state.ts）用同一套可显示性守卫，不可显示就换成收藏时刻。
function isDisplayableDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    beijingDate(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeRoleFamily(value: unknown): RoleFamily | undefined {
  return typeof value === "string" && ROLE_FAMILIES.has(value) ? (value as RoleFamily) : undefined;
}

function normalizeLocations(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations = value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
  return locations.length > 0 ? locations : undefined;
}

/** 一条合法记录：id/title/company 是必需的，其余字段尽量沿用；坏的整条丢掉而不是让页面崩掉。 */
function normalizeJob(value: unknown): LocalStarredJob | null {
  if (!isRecord(value)) return null;
  const { id, title, company } = value;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (typeof title !== "string" || title.trim() === "") return null;
  // 空公司会渲染成「 · 地点未知」，当作非法记录丢掉。
  if (typeof company !== "string" || company.trim() === "") return null;
  const job: LocalStarredJob = {
    id,
    title,
    company,
    savedAt: isDisplayableDate(value.savedAt) ? value.savedAt : new Date().toISOString(),
  };
  const roleFamily = normalizeRoleFamily(value.roleFamily);
  if (roleFamily) job.roleFamily = roleFamily;
  const locations = normalizeLocations(value.locations);
  if (locations) job.locations = locations;
  return job;
}

function readStarredJobs(): LocalStarredJob[] {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(STARRED_JOBS_KEY) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const jobs: LocalStarredJob[] = [];
  const seen = new Set<string>();
  for (const value of parsed) {
    const job = normalizeJob(value);
    if (!job || seen.has(job.id)) continue;
    seen.add(job.id);
    jobs.push(job);
    if (jobs.length === STARRED_JOBS_LIMIT) break;
  }
  return jobs;
}

function writeStarredJobs(jobs: LocalStarredJob[]): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(STARRED_JOBS_KEY, JSON.stringify(jobs));
    return true;
  } catch {
    return false;
  }
}

/** 收藏的岗位，最新在前；没有数据、数据损坏或浏览器不给存储时返回空数组。 */
export function getStarredJobs(): LocalStarredJob[] {
  if (cached === null) cached = readStarredJobs();
  return cached;
}

/** 这个岗位是否已收藏。 */
export function isStarredJob(id: string): boolean {
  if (cachedIds === null) cachedIds = new Set(getStarredJobs().map((job) => job.id));
  return cachedIds.has(id);
}

/**
 * 切换一个岗位的收藏状态，返回切换后是否已收藏；写不进去（存储满或不可用）返回 false 且不抛错。
 * 先读最新数据：另一个标签页可能刚写过，不能拿旧快照覆盖它。
 */
export function toggleStarredJob(job: Omit<LocalStarredJob, "savedAt">): boolean {
  resetCache();
  const list = getStarredJobs();
  const exists = list.some((item) => item.id === job.id);
  const next = exists
    ? list.filter((item) => item.id !== job.id)
    : [{ ...job, savedAt: new Date().toISOString() }, ...list].slice(0, STARRED_JOBS_LIMIT);
  if (!writeStarredJobs(next)) return false;
  invalidate();
  return !exists;
}

/** 从收藏里移除一个岗位；本来就不在或写不进去时保持原样，不抛错。 */
export function removeStarredJob(id: string): void {
  resetCache();
  const list = getStarredJobs();
  if (!list.some((item) => item.id === id)) return;
  if (writeStarredJobs(list.filter((item) => item.id !== id))) invalidate();
}

const EMPTY_STARRED_JOBS: LocalStarredJob[] = [];

/** 收藏的岗位列表；服务端快照固定为空，hydration 后才切换到本浏览器的值。 */
export function useStarredJobs(): LocalStarredJob[] {
  return useSyncExternalStore(subscribe, getStarredJobs, () => EMPTY_STARRED_JOBS);
}

/** 一个岗位是否已收藏；服务端快照固定为 false，与首屏 HTML 一致。 */
export function useIsStarredJob(id: string): boolean {
  return useSyncExternalStore(subscribe, () => isStarredJob(id), () => false);
}
