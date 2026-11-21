// 岗位收藏的浏览器存储与 hook：standalone，不连数据库、不需要 Web 进程。
// 每个用例换一份假 localStorage/假 window 并重新 import 模块，等价于重新打开一个标签页；
// storage 事件用普通对象派发，模拟另一个标签页写入。
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beijingDate } from "@aihot/contracts/time";

const KEY = "aihot-starred-jobs";
const LIMIT = 200;

const originals = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
};
after(() => {
  for (const key of ["localStorage", "window"] as const) {
    const descriptor = originals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

interface TestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface TestStorageEvent {
  key: string | null;
  storageArea?: unknown;
}
type Listener = (event: TestStorageEvent) => void;

function fakeBrowser(raw?: string) {
  const values = new Map<string, string>();
  if (raw !== undefined) values.set(KEY, raw);
  const listeners = new Set<Listener>();
  const store: TestStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
  const win = {
    localStorage: store,
    addEventListener: (_type: "storage", listener: Listener) => { listeners.add(listener); },
    removeEventListener: (_type: "storage", listener: Listener) => { listeners.delete(listener); },
  };
  return {
    values,
    store,
    win,
    dispatch(event: TestStorageEvent) { for (const listener of [...listeners]) listener(event); },
    listenerCount: () => listeners.size,
  };
}

let instance = 0;
async function reader(raw?: string) {
  const browser = fakeBrowser(raw);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: browser.store });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: browser.win });
  const mod: typeof import("../web/job-favorites.ts") = await import(`../web/job-favorites.ts?test=${instance++}`);
  return { mod, ...browser };
}

async function readerWithoutStorage() {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: undefined });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: undefined });
  const mod: typeof import("../web/job-favorites.ts") = await import(`../web/job-favorites.ts?test=${instance++}`);
  return mod;
}

function starredJobs(mod: typeof import("../web/job-favorites.ts")) {
  return mod.getStarredJobs().map((job) => job.id);
}

test("a starred job keeps its snapshot and toggles off and on again", async () => {
  const { mod, values } = await reader();
  assert.equal(mod.STARRED_JOBS_KEY, KEY);
  const job = { id: "job-1", title: "AI 算法工程师", company: "示例公司", roleFamily: "ai_algorithm" as const, locations: ["北京", "上海"] };

  assert.equal(mod.toggleStarredJob(job), true);
  const [saved] = mod.getStarredJobs();
  assert.deepEqual({ ...saved, savedAt: undefined }, { ...job, savedAt: undefined });
  assert.ok(Date.parse(saved!.savedAt) > Date.now() - 60_000, "saving takes the current time");
  assert.equal(JSON.parse(values.get(KEY)!)[0].title, job.title);

  // 再次点击同一个岗位是取消收藏，本地数据同步清空。
  assert.equal(mod.toggleStarredJob(job), false);
  assert.deepEqual(mod.getStarredJobs(), []);
  assert.equal(values.get(KEY), "[]");

  // 取消后再收藏，仍然只有一条。
  assert.equal(mod.toggleStarredJob(job), true);
  assert.deepEqual(starredJobs(mod), ["job-1"]);
});

test("the list keeps the newest 200 jobs", async () => {
  const { mod } = await reader();
  for (let i = 0; i < LIMIT + 5; i++) {
    assert.equal(mod.toggleStarredJob({ id: `job-${i}`, title: `岗位 ${i}`, company: "示例公司" }), true);
  }
  const saved = mod.getStarredJobs();
  assert.equal(saved.length, LIMIT);
  assert.equal(saved[0]!.id, `job-${LIMIT + 4}`, "newest first");
  assert.equal(saved.at(-1)!.id, "job-5", "the oldest five fell off");
});

test("damaged or malformed stored data is filtered out instead of shown", async () => {
  const valid = { id: "ok-1", title: "标题一", company: "公司", savedAt: "2026-11-20T10:00:00.000Z" };
  const raw = JSON.stringify([
    valid,
    null,
    42,
    "text",
    [],
    {},
    { id: "bad id!", title: "坏 id", company: "公司" },
    { id: "missing-title", company: "公司" },
    { id: "missing-company", title: "缺公司" },
    { id: "empty-company", title: "空公司", company: "  " },
    { ...valid, title: "重复的 id" },
    { id: "ok-2", title: "标题二", company: "公司二", roleFamily: "not_a_family", locations: ["北京", 3, ""], savedAt: "broken" },
  ]);
  const { mod } = await reader(raw);
  const saved = mod.getStarredJobs();
  assert.deepEqual(saved.map((job) => job.id), ["ok-1", "ok-2"]);
  assert.equal(saved[0]!.title, "标题一", "the first copy of a duplicated id wins");
  assert.equal(saved[1]!.roleFamily, undefined, "an unknown role family is dropped");
  assert.deepEqual(saved[1]!.locations, ["北京"], "non-string locations are dropped");
  assert.doesNotThrow(() => beijingDate(saved[1]!.savedAt), "a damaged saved date is replaced with a displayable one");

  for (const damaged of ["not json", JSON.stringify({ jobs: [] }), "null", ""]) {
    const { mod: damagedMod } = await reader(damaged);
    assert.deepEqual(damagedMod.getStarredJobs(), [], `${damaged} must read as empty`);
  }

  // 损坏的数据不影响新的收藏写入。
  const { mod: writable } = await reader("not json");
  assert.equal(writable.toggleStarredJob(valid), true);
  assert.deepEqual(starredJobs(writable), ["ok-1"]);
});

test("saved dates that cannot be displayed in Beijing time are replaced instead of breaking the page", async () => {
  // +275760-09-13 是 JS 能表示的最大瞬间：Date.parse 通过，但 +8 小时后 toISOString 抛 RangeError。
  const raw = JSON.stringify([
    { id: "max-date", title: "最大日期", company: "公司", savedAt: "+275760-09-13T00:00:00.000Z" },
    { id: "bad-date", title: "坏日期", company: "公司", savedAt: "broken" },
  ]);
  const { mod } = await reader(raw);
  const saved = mod.getStarredJobs();
  assert.deepEqual(saved.map((job) => job.id), ["max-date", "bad-date"]);
  for (const job of saved) {
    assert.doesNotThrow(() => beijingDate(job.savedAt), `${job.id} 的收藏日期必须能显示`);
    assert.ok(Date.parse(job.savedAt) > Date.now() - 60_000, "an undisplayable date falls back to the save time");
  }
});

test("stored jobs beyond the 200-item window are ignored on read", async () => {
  const raw = JSON.stringify(Array.from({ length: LIMIT + 25 }, (_, i) => ({
    id: `stored-${i}`, title: `岗位 ${i}`, company: "公司", savedAt: "2026-11-20T10:00:00.000Z",
  })));
  const { mod } = await reader(raw);
  assert.equal(mod.getStarredJobs().length, LIMIT);
  assert.equal(mod.getStarredJobs()[0]!.id, "stored-0");
});

test("job favorites and article favorites never share a key", async () => {
  const article = { id: "article-1", title: "文章收藏", summary: null, sourceName: "来源", savedAt: "2026-11-20T10:00:00.000Z", publishedAt: null, score: null, aiSelected: false };
  const { mod, values } = await reader();
  values.set("aihot-starred-items", JSON.stringify([article]));
  assert.equal(mod.toggleStarredJob({ id: "job-1", title: "岗位", company: "公司" }), true);
  assert.deepEqual(JSON.parse(values.get("aihot-starred-items")!), [article], "岗位收藏不写文章收藏的 key");
  assert.deepEqual(JSON.parse(values.get(KEY)!).map((job: { id: string }) => job.id), ["job-1"]);
  mod.removeStarredJob("job-1");
  assert.deepEqual(JSON.parse(values.get("aihot-starred-items")!), [article], "移除岗位也不碰文章收藏");
  assert.equal(values.get(KEY), "[]");
});

test("another tab's write refreshes the snapshot and notifies subscribers", async () => {
  const { mod, values, win, dispatch, listenerCount } = await reader(JSON.stringify([]));
  let calls = 0;
  const stop = mod.watchStarredJobs(() => { calls += 1; });
  assert.equal(listenerCount(), 1, "the first subscriber listens for storage events");

  // 本标签页的切换也要通知 React 之外的回调。
  assert.equal(mod.toggleStarredJob({ id: "job-a", title: "岗位 A", company: "公司" }), true);
  assert.equal(calls, 1);

  // 另一个标签页写入：storage 事件带 key 与 storageArea。
  values.set(KEY, JSON.stringify([{ id: "job-b", title: "岗位 B", company: "公司", savedAt: "2026-11-20T10:00:00.000Z" }]));
  dispatch({ key: KEY, storageArea: win.localStorage });
  assert.equal(calls, 2);
  assert.deepEqual(starredJobs(mod), ["job-b"], "the cached snapshot is invalidated by the event");

  // 其它 key、其它存储区都不影响岗位收藏。
  dispatch({ key: "aihot-theme", storageArea: win.localStorage });
  dispatch({ key: KEY, storageArea: {} });
  assert.equal(calls, 2);

  // key 为 null 是另一个标签页清空了存储。
  values.delete(KEY);
  dispatch({ key: null, storageArea: win.localStorage });
  assert.equal(calls, 3);
  assert.deepEqual(mod.getStarredJobs(), []);

  stop();
  assert.equal(listenerCount(), 0, "the last unsubscribe drops the storage listener");
});

test("a failed write returns false without crashing and leaves the stored data as it was", async () => {
  const { mod, store, values } = await reader();
  const job = { id: "job-1", title: "岗位", company: "公司" };
  const write = store.setItem;
  store.setItem = () => { throw new Error("quota exceeded"); };
  assert.equal(mod.toggleStarredJob(job), false);
  assert.deepEqual(mod.getStarredJobs(), []);
  assert.doesNotThrow(() => mod.removeStarredJob("job-1"));
  assert.equal(mod.isStarredJob("job-1"), false);
  assert.equal(values.get(KEY), undefined, "nothing was written");
  // 存储恢复可用后仍可正常收藏。
  store.setItem = write;
  assert.equal(mod.toggleStarredJob(job), true);
  assert.deepEqual(starredJobs(mod), ["job-1"]);
});

test("no storage and no window is an empty, writable-failure-only state (SSR safe)", async () => {
  const mod = await readerWithoutStorage();
  assert.deepEqual(mod.getStarredJobs(), []);
  assert.equal(mod.isStarredJob("job-1"), false);
  assert.equal(mod.toggleStarredJob({ id: "job-1", title: "岗位", company: "公司" }), false);
  assert.doesNotThrow(() => mod.removeStarredJob("job-1"));
  const stop = mod.watchStarredJobs(() => {});
  assert.doesNotThrow(stop);
});

test("server rendering uses the empty snapshot even when this browser has favorites", async () => {
  const { mod } = await reader(JSON.stringify([{ id: "job-1", title: "岗位", company: "公司", savedAt: "2026-11-20T10:00:00.000Z" }]));
  function Probe() {
    const jobs = mod.useStarredJobs();
    const starred = mod.useIsStarredJob("job-1");
    return createElement("span", null, `${jobs.length}:${starred}`);
  }
  assert.equal(renderToStaticMarkup(createElement(Probe)), "<span>0:false</span>");
});
