import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import type { ItemAvailability } from "@aihot/contracts/site";
import type { JobAvailabilityResponseV1 } from "@aihot/career-insights/contracts";
import { shortAddresses } from "@aihot/contracts/addresses";
import { SITE } from "@aihot/site";
import { Presence } from "../components/ui/Presence";
import { edgeTtl } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { exportBundle, importBundle, removeStar, useStarred, type ImportReport } from "../lib/local-state";
import { removeStarredJob, useStarredJobs } from "../../../../modules/career-insights/web/job-favorites.ts";
import { ROLE_FAMILY_LABELS } from "../../../../modules/career-insights/web/labels.ts";
import { fullDateTime } from "../lib/format";
import { IconBookmark, IconDownload, IconClose } from "../components/icons";
import { readSnapshot, restoreAnchor, useSaveOnLeave } from "../lib/restore";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";
import { webModules } from "../site-modules";

export const handle: Screen = { tab: "me", name: "收藏" };

export function headers() {
  return edgeTtl(300);
}

export function meta() {
  return pageMeta({ title: "我的收藏", description: `收藏的 ${SITE.name} 内容，适合稍后阅读和回看。`, path: "/starred", noindex: true });
}

// 岗位可用性探测的批次大小：后端一次接受去重后 200 个，但 UUID 比文章 id 长，
// 200 个的 query 约 7.8k 字符，贴近反向代理常见的 8K 请求行上限，所以和文章收藏一样按 100/批发送。
const AVAILABILITY_BATCH_SIZE = 100;
// 只探测严格 UUID：收藏里可能残留旧格式 id（job-favorites 的 ID_PATTERN 更宽），
// 不能因为一条坏 id 让后端 400，把所有徽标都吞掉。
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reportText(r: ImportReport): string {
  const parts = [`新增收藏 ${r.starredAdded} 条`, `已读记录 ${r.readAdded} 条`];
  if (r.starredSkipped || r.readSkipped) parts.push(`有 ${r.starredSkipped + r.readSkipped} 条没导入（超出数量上限或格式不对）`);
  if (r.themeApplied) parts.push("已沿用导入的深浅色设置");
  if (r.fontApplied) parts.push("已沿用导入的字体设置");
  if (r.readFailed) parts.push("已读记录没能保存（浏览器存储已满或不可用）");
  return parts.join("，");
}

export default function StarredPage() {
  const starred = useStarred();
  const starredJobs = useStarredJobs();
  const [mounted, setMounted] = useState(false);
  const [availability, setAvailability] = useState<Record<string, ItemAvailability>>({});
  // 岗位收藏是本地快照，可能早已下架；只记 missing 的 id，接口没答出结果的 id 不显示徽标。
  const [missingJobs, setMissingJobs] = useState<Record<string, true>>({});
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => setMounted(true), []);

  const starredIds = starred.map((s) => s.id).join(",");
  useEffect(() => {
    if (!mounted || !starredIds) return;
    const controller = new AbortController();
    // Batches of 100: a request line with all 500 ids is longer than the front servers accept.
    const ids = starredIds.split(",");
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100));
    Promise.all(
      batches.map((batch) =>
        fetch(`/api/site/items/availability?ids=${encodeURIComponent(batch.join(","))}`, { signal: controller.signal })
          .then((r) => (r.ok ? (r.json() as Promise<Record<string, ItemAvailability>>) : {}))
          .catch(() => ({})),
      ),
    ).then((parts) => {
      if (!controller.signal.aborted) setAvailability(Object.assign({}, ...parts));
    });
    return () => controller.abort();
  }, [mounted, starredIds]);

  // 岗位可用性同样只探测已收藏的 id，按 100 个一批发送（见 AVAILABILITY_BATCH_SIZE）。
  // 接口失败或超时静默降级：不显示徽标，收藏列表照常渲染。
  const starredJobIds = starredJobs.map((job) => job.id).filter((id) => JOB_ID_PATTERN.test(id)).join(",");
  useEffect(() => {
    if (!mounted) return;
    if (!starredJobIds) {
      // 收藏清空（或只剩旧格式 id）时清掉旧结果，避免之后再收藏同一 id 时先闪一下过期徽标。
      setMissingJobs({});
      return;
    }
    const controller = new AbortController();
    const ids = starredJobIds.split(",");
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += AVAILABILITY_BATCH_SIZE) batches.push(ids.slice(i, i + AVAILABILITY_BATCH_SIZE));
    Promise.all(
      batches.map((batch) =>
        fetch(`/api/site/career-insights/jobs/availability?ids=${encodeURIComponent(batch.join(","))}`, { signal: controller.signal })
          .then((r) => (r.ok ? (r.json() as Promise<JobAvailabilityResponseV1>) : null))
          .catch(() => null),
      ),
    ).then((parts) => {
      if (controller.signal.aborted) return;
      const missing: Record<string, true> = {};
      for (const part of parts) {
        for (const [id, status] of Object.entries(part?.ids ?? {})) if (status === "missing") missing[id] = true;
      }
      setMissingJobs(missing);
    });
    return () => controller.abort();
  }, [mounted, starredJobIds]);

  // Back from an item: the list renders only after mounting (it lives in this browser), so the
  // position comes back once it is there, by the same card anchor the other lists use.
  const historyKey = useLocation().key;
  useLayoutEffect(() => {
    if (!mounted || starred.length === 0) return;
    const snap = readSnapshot<null>(historyKey);
    if (snap) restoreAnchor(snap.anchor, snap.scrollY);
  }, [mounted, historyKey]);
  useSaveOnLeave(historyKey, () => null);

  const doExport = () => {
    const blob = new Blob([JSON.stringify(exportBundle(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${SITE.mcpPrefix}-local-data-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const report = importBundle(await file.text());
      setNotice({ kind: report.readFailed ? "error" : "ok", text: `导入完成：${reportText(report)}` });
    } catch (e) {
      setNotice({ kind: "error", text: e instanceof Error ? e.message : "导入失败" });
    }
  };

  // Imports from elsewhere that the site's modules offer.
  const importFrom = (run: () => Promise<{ ok: boolean; text: string }>) =>
    run().then(
      (r) => setNotice({ kind: r.ok ? "ok" : "error", text: r.text }),
      (err: Error) => setNotice({ kind: "error", text: err.message }),
    );

  const action = "inline-flex min-h-11 items-center text-[12.5px] text-ink-3 transition-colors hover:text-accent";
  const Account = webModules().find((m) => m.account)?.account;
  const localNote = <p className="rounded-tile border border-line bg-surface px-4 py-2.5 text-[12.5px] text-ink-3">不用登录，收藏直接存在这个浏览器里；清除浏览器数据或换设备都不会同步。导出/导入目前只包含文章收藏，岗位收藏只存在这个浏览器里。</p>;
  return (
    <div className="pb-12">
      <PhoneBar back={{ to: "/more", label: "我的" }} title="收藏" />
      <header className="flex flex-col gap-2 pb-4 pt-3 sm:flex-row sm:items-start sm:justify-between lg:pt-1">
        <div>
          <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">收藏</h1>
          <p className="mt-1.5 text-[13px] text-ink-3">{`收藏的 ${SITE.name} 内容，适合稍后阅读和回看。`}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:pt-1.5">
          {webModules().flatMap((m) => m.starredImports ?? []).map((i) => (
            <button key={i.label} type="button" onClick={() => importFrom(i.run)} className={action}>
              {i.label}
            </button>
          ))}
          <button type="button" onClick={() => fileRef.current?.click()} className={action}>
            导入文件
          </button>
          {mounted && starred.length > 0 && (
            <button type="button" onClick={doExport} className={`${action} inline-flex items-center gap-1`}>
              <IconDownload size={13} /> 导出
            </button>
          )}
          <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" onChange={(e) => doImport(e.target.files?.[0])} />
        </div>
      </header>
      {Account ? <Account place="starred" /> : localNote}
      <Presence show={!!notice} enter="anim-notice-in" exit="anim-fade-out" duration={160}>
        <div
          role="status"
          className={`mt-3 flex items-start justify-between gap-3 rounded-tile px-4 py-2.5 text-[13px] ${notice?.kind === "ok" ? "bg-accent-soft text-accent-ink dark:text-accent" : "bg-hot-soft text-hot"}`}
        >
          {notice?.text}
          <button type="button" aria-label="关闭" onClick={() => setNotice(null)} className="shrink-0 opacity-70 hover:opacity-100">
            <IconClose size={14} />
          </button>
        </div>
      </Presence>
      {mounted && (
        <section data-starred-jobs="" aria-labelledby="starred-jobs-title" className="mt-6">
          <h2 id="starred-jobs-title" className="text-[18px] font-semibold text-ink">收藏的岗位</h2>
          {starredJobs.length === 0 ? (
            <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
              还没有收藏的岗位，在
              <Link to="/career-insights/jobs" className="font-medium text-accent hover:underline">
                热门岗位
              </Link>
              或职位详情点收藏
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-line-soft overflow-hidden rounded-card border border-line bg-surface">
              {starredJobs.map((job) => {
                const missing = missingJobs[job.id] === true;
                return (
                  <li key={job.id} data-starred-job={job.id} data-starred-job-missing={missing ? "true" : undefined} className="flex items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <h3 className="text-[15px] font-semibold leading-[1.6] text-ink">
                        <Link viewTransition to={`/career-insights/jobs/${encodeURIComponent(job.id)}`} className="break-words transition-colors hover:text-accent">
                          {job.title}
                        </Link>
                        {missing && (
                          <span className="ml-2 inline-flex shrink-0 items-center rounded-full bg-hot-soft px-2 py-0.5 align-middle text-[11.5px] font-medium text-hot">
                            可能已下架（仍可移除）
                          </span>
                        )}
                      </h3>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3 break-words">
                        {[job.company, job.locations?.join("、") || "地点未知", ROLE_FAMILY_LABELS[job.roleFamily ?? "unknown"]].join(" · ")}
                      </p>
                      <p className="mt-1 text-[11.5px] text-ink-4">
                        收藏于 <span className="num">{fullDateTime(job.savedAt)}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`移除收藏：${job.title}`}
                      onClick={() => removeStarredJob(job.id)}
                      className="inline-flex min-h-11 shrink-0 items-center px-2 -mr-2 text-[12.5px] text-ink-3 transition-colors hover:text-accent"
                    >
                      移除
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {!mounted ? null : starred.length === 0 ? (
        <div className="mt-3 flex flex-col items-center rounded-card border border-dashed border-line-strong px-6 py-12 text-center">
          <IconBookmark size={20} className="text-ink-4" />
          <p className="mt-3 text-[13px] text-ink-3">还没有收藏的文章。点开任意一条内容，在详情页点击收藏即可添加。</p>
          <p className="mt-1.5 text-[13px] text-ink-3">
            本站内容暂未接入，可先查看
            <Link to="/career-insights" className="font-medium text-accent hover:underline">
              就业趋势洞察
            </Link>
            。
          </p>
          <Link to="/" className="mt-4 text-[12.5px] font-medium text-accent hover:text-accent-ink">
            去看精选 →
          </Link>
        </div>
      ) : (
        <ul className="mt-3 lg:space-y-3">
          {starred.map((s) => {
            const current = availability[s.id];
            const status = current?.status;
            const unavailable = status === "unavailable";
            return (
              <li key={s.id} data-card-key={s.id} className={`relative border-b border-line-soft py-4 lg:card lg:px-[18px] lg:py-[15px] ${unavailable ? "opacity-70" : "lg:card-hover"}`}>
                <div className="flex items-center gap-2 text-[12.5px] text-ink-4">
                  <span className="min-w-0 truncate text-ink-3">{current?.sourceName ?? s.sourceName}</span>
                  {s.publishedAt && <span className="num shrink-0">· {fullDateTime(s.publishedAt)}</span>}
                  <span className="ml-auto hidden shrink-0 sm:inline">
                    收藏于 <span className="num">{fullDateTime(s.savedAt)}</span>
                  </span>
                  <button type="button" aria-label="取消收藏" title="取消收藏" onClick={() => removeStar(s.id)} className="relative z-10 -my-1 ml-auto grid size-7 shrink-0 place-items-center rounded-full text-ink-4 transition-colors hover:bg-bg-sunk hover:text-ink sm:ml-0">
                    <IconClose size={14} />
                  </button>
                </div>
                <h2 className="mt-1.5 text-[16px] font-[650] leading-[1.55] text-ink">
                  {unavailable ? (
                    s.title
                  ) : (
                    <Link viewTransition to={`/items/${s.id}`} className="transition-colors after:absolute after:inset-0 after:content-[''] hover:text-accent">
                      {s.title}
                    </Link>
                  )}
                </h2>
                {s.summary && <p className="mt-1.5 line-clamp-2 text-[14px] leading-[1.75] text-ink-3">{shortAddresses(s.summary)}</p>}
                {unavailable && <p className="mt-2 text-[12.5px] text-hot">这条内容已经下架，收藏会一直保留，直到你手动移除。</p>}
                {status === "summary-only" && <p className="mt-2 text-[12.5px] text-amber-ink">这条内容现在只提供摘要。</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
