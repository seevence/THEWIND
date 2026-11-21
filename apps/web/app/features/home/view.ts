// 首页区块的展示口径：纯函数与文案，客户端与服务端共用以保证 SSR 与交互后文本一致。
import type { MetricResultV1, MetricSpecV1, SummaryResponseV1 } from "@aihot/career-insights/contracts";

export const BLOCK_UNAVAILABLE = "本区块暂时不可用";
export const BLOCK_UNAVAILABLE_HINT = "该区块的数据请求失败，其余内容不受影响，可稍后刷新重试。";
export const KEEP_OBSERVING = "继续积累观测";
export const KEEP_OBSERVING_HINT = "样本不足或离线研判尚未生成，观测积累后自动更新。";

export interface HomeIndicatorV1 {
  label: string;
  value: string;
  note: string;
  pending: boolean;
}

function metric(summary: SummaryResponseV1, metricId: MetricSpecV1["metric_id"]): MetricResultV1 | null {
  return summary.metrics.find((entry) => entry.metric_id === metricId) ?? null;
}

/** 三个指标：观察窗新增岗位、活跃招聘企业、学生友好岗位。数据不足时只显示「继续积累观测」。 */
export function homeIndicators(summary: SummaryResponseV1): HomeIndicatorV1[] {
  const newJobs = metric(summary, "observed_new_jobs");
  const friendly = metric(summary, "student_friendly_share");
  const newJobsReady = newJobs?.status === "ok" && newJobs.value !== null;
  const friendlyReady = friendly?.status === "ok";

  return [
    {
      label: "观察窗新增岗位",
      value: newJobsReady ? String(newJobs.value) : KEEP_OBSERVING,
      note: "前后两次观测快照间首次出现的岗位，不等于市场真实新增。",
      pending: !newJobsReady,
    },
    {
      label: "活跃招聘企业",
      value: String(summary.company_count),
      note: "样本内当前有有效岗位的公司数。",
      pending: false,
    },
    {
      label: "学生友好岗位",
      value: friendlyReady ? String(friendly.numerator_count) : KEEP_OBSERVING,
      // 用户确认保留此指标但必须写清口径：只看明确证据，unknown 不计入、也不等于不友好。
      note: "仅统计明确校招/实习/经验不限；当前样本以社招为主，unknown 不等于不友好。",
      pending: !friendlyReady,
    },
  ];
}
