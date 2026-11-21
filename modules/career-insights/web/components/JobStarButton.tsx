// 岗位收藏按钮（客户端交互）：服务端与 hydration 都先按未收藏渲染（useIsStarredJob 的服务端快照为
// false），挂载后由 localStorage 恢复真实状态，因此首屏 HTML 与 hydration 一致，不产生 mismatch。
import { toggleStarredJob, useIsStarredJob, type LocalStarredJob } from "../job-favorites";

export type JobStarButtonProps = Omit<LocalStarredJob, "savedAt"> & {
  /** 岗位列表行用的小号按钮；职位详情页不传，用默认尺寸。 */
  compact?: boolean;
};

const BUTTON_CLASS = "inline-flex shrink-0 items-center justify-center rounded-full border font-medium transition-colors";
const COMPACT_CLASS = `${BUTTON_CLASS} min-h-11 min-w-11 justify-center px-3 text-[12px] sm:h-7 sm:min-h-0 sm:min-w-0 sm:px-2.5 sm:text-[11.5px]`;
const DEFAULT_CLASS = `${BUTTON_CLASS} h-11 px-4 text-[13px] sm:h-9`;
const STARRED_CLASS = "border-accent bg-accent text-accent-contrast";
const IDLE_CLASS = "border-line-strong bg-surface text-ink-2 hover:border-accent hover:text-accent";

export function JobStarButton({ id, title, company, roleFamily, locations, compact = false }: JobStarButtonProps) {
  const starred = useIsStarredJob(id);
  return (
    <button
      type="button"
      data-job-star={starred ? "on" : "off"}
      aria-pressed={starred}
      aria-label={`${starred ? "取消收藏" : "收藏"}岗位：${title}`}
      onClick={() => toggleStarredJob({ id, title, company, roleFamily, locations })}
      className={`${compact ? COMPACT_CLASS : DEFAULT_CLASS} ${starred ? STARRED_CLASS : IDLE_CLASS}`}
    >
      {starred ? "已收藏" : "收藏"}
    </button>
  );
}
