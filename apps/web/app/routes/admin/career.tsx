// 后台「就业数据」：运营/评委看就业采集、LLM 兜底、研判与日报评论的运行状态和数据规模。
// 只读、纯服务端渲染；数据来自 GET /api/admin/career（管理员会话由 admin layout 的 loader 保证）。
// 单段查询失败（接口 5xx/未接线/网络错误）只把整页降级为「数据暂不可用」，登录跳转仍按后台统一处理。
import type { ReactNode } from "react";
import type { Route } from "./+types/career";
import type {
  CareerAdminBriefStep,
  CareerAdminCommentStep,
  CareerAdminJobRun,
  CareerAdminLlmStep,
  CareerAdminOverview,
  CareerAdminSection,
} from "@aihot/career-insights/contracts";
import { SITE } from "@aihot/site";
import { adminGet } from "../../lib/admin.server";
import { bj, duration, num } from "../../features/admin/format";
import { AdminPage, Badge, Card, DataTable, Empty, Stat, Time } from "../../features/admin/ui";

export async function loader({ request }: Route.LoaderArgs) {
  try {
    return { overview: await adminGet<CareerAdminOverview>(request, "/api/admin/career"), unavailable: false as const };
  } catch (error) {
    // 未登录仍是登录跳转；其余失败（接口未接线、5xx、网络）让页面显示「数据暂不可用」。
    if (error instanceof Response) throw error;
    return { overview: null, unavailable: true as const };
  }
}

export const meta: Route.MetaFunction = () => [{ title: `就业数据 · ${SITE.name} 后台` }];

const INGEST_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  ok: { label: "成功", tone: "ok" },
  partial: { label: "部分", tone: "warn" },
  failed: { label: "失败", tone: "bad" },
};

const JOB_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  ok: { label: "完成", tone: "ok" },
  failed: { label: "失败", tone: "bad" },
  skipped: { label: "跳过", tone: "warn" },
  running: { label: "运行中", tone: "muted" },
};

const STEP_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  ok: { label: "成功", tone: "ok" },
  skipped: { label: "无样本跳过", tone: "warn" },
  failed: { label: "失败", tone: "bad" },
};

const CONFIDENCE_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };
const KIND_LABEL: Record<string, string> = { jobs: "岗位", policy: "政策" };

const ms = (value: number | null): string => (value === null ? "—" : value >= 10_000 ? `${Math.round(value / 1000)} s` : `${(value / 1000).toFixed(1)} s`);
const confidence = (value: string | null): string => (value === null ? "—" : CONFIDENCE_LABEL[value] ?? value);

function SectionEmpty({ children = "数据暂不可用" }: { children?: ReactNode }) {
  return <Empty>{children}</Empty>;
}

function StepBadge({ step }: { step: { ok: boolean | null; skipped: boolean | null; reason: string | null } | null }) {
  if (step === null) return <span className="text-ink-4">—</span>;
  const status = step.ok === true ? "ok" : step.skipped === true ? "skipped" : "failed";
  const tone = STEP_STATUS[status]!.tone;
  return <Badge tone={tone} title={step.reason ?? undefined}>{STEP_STATUS[status]!.label}</Badge>;
}

/** LLM 兜底的汇总没有 skipped 布尔值：ok=false 就是子进程失败，ok=null 是旧记录。 */
function LlmStepBadge({ llm }: { llm: CareerAdminLlmStep | null }) {
  if (llm === null) return <span className="text-ink-4">—</span>;
  if (llm.ok === null) return <Badge tone="muted">—</Badge>;
  return <Badge tone={llm.ok ? "ok" : "bad"} title={llm.error ?? undefined}>{llm.ok ? "成功" : "失败"}</Badge>;
}

function LlmSummary({ llm }: { llm: CareerAdminLlmStep }) {
  const stop = llm.stopped_by_budget ?? (llm.skipped?.reason ?? null);
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="候选行" value={num(llm.candidates)} hint={`调用 ${num(llm.called)} 行 / ${num(llm.calls)} 次（重试 ${num(llm.retries)}）`} />
        <Stat label="写回" value={num(llm.changed)} hint={`失败 ${num(llm.failed)} 行`} tone={llm.failed ? "bad" : undefined} />
        <Stat label="预算" value={`${num(llm.budget?.rows)}/${num(llm.budget?.max_rows)}`} hint={`约 ${num(llm.budget?.prompt_tokens_estimated)}/${num(llm.budget?.max_prompt_tokens)} prompt token`} tone={stop ? "warn" : undefined} />
        <Stat label="用量" value={num(llm.usage?.prompt_tokens)} hint={`输出 ${num(llm.usage?.completion_tokens)} token`} />
      </div>
      {stop !== null && (
        <p className="mb-3 rounded-control bg-amber/10 px-3 py-2 text-[12.5px] text-amber">
          触顶 {stop}：跳过 {num(llm.skipped?.rows)} 行，下一轮窗口已不覆盖这些行
        </p>
      )}
      {llm.error !== null && <p className="text-[12.5px] text-hot">兜底失败：{llm.error}</p>}
    </>
  );
}

function BriefStepLine({ step }: { step: CareerAdminBriefStep | null }) {
  if (step === null) return <span className="text-ink-4">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-[12.5px]">
      <StepBadge step={step} />
      {step.as_of && <span className="num text-ink-3">数据截止 {bj(step.as_of)}</span>}
      {step.sample_size !== null && <span className="text-ink-3">样本 {num(step.sample_size)}</span>}
      {step.confidence !== null && <span className="text-ink-3">置信度 {confidence(step.confidence)}</span>}
      {step.receipt_id !== null && <span className="num text-ink-3">回执 #{step.receipt_id}</span>}
      {step.model !== null && <span className="font-mono text-[11.5px] text-ink-4">{step.model}</span>}
      {step.error !== null && <span className="text-hot">{step.error}</span>}
    </span>
  );
}

function CommentStepLine({ step }: { step: CareerAdminCommentStep | null }) {
  if (step === null) return <span className="text-ink-4">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-[12.5px]">
      <StepBadge step={step} />
      {step.date !== null && <span className="num text-ink-3">{step.date}</span>}
      {step.sample_size !== null && <span className="text-ink-3">样本 {num(step.sample_size)}</span>}
      {step.new_jobs !== null && <span className="text-ink-3">新增 {num(step.new_jobs)}</span>}
      {step.confidence !== null && <span className="text-ink-3">置信度 {confidence(step.confidence)}</span>}
      {step.receipt_id !== null && <span className="num text-ink-3">回执 #{step.receipt_id}</span>}
      {step.model !== null && <span className="font-mono text-[11.5px] text-ink-4">{step.model}</span>}
      {step.error !== null && <span className="text-hot">{step.error}</span>}
    </span>
  );
}

function JobRunCard({ section }: { section: CareerAdminSection<CareerAdminJobRun | null> }) {
  if (!section.ok) return <SectionEmpty />;
  const run = section.data;
  if (run === null) return <SectionEmpty>还没有运行记录（每日管线 06:10 首次运行后出现）</SectionEmpty>;
  const status = JOB_STATUS[run.status] ?? JOB_STATUS.running!;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-[13px]">
        <span className="font-mono text-[12px] text-ink-3">{run.job}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="num text-ink-3">开始 {bj(run.started_at)}</span>
        <span className="num text-ink-3">耗时 {duration(run.started_at, run.finished_at)}</span>
        {run.error !== null && <span className="text-hot">{run.error}</span>}
      </div>
      {run.llm !== null && <LlmSummary llm={run.llm} />}
      <div className="space-y-2 border-t border-line pt-3 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 shrink-0 text-ink-3">兜底</span>
          <LlmStepBadge llm={run.llm} />
          {run.llm !== null && run.llm.duration_ms !== null && <span className="num text-ink-3">耗时 {ms(run.llm.duration_ms)}</span>}
          {run.llm !== null && run.llm.exit_code !== null && <span className="num text-ink-3">退出码 {String(run.llm.exit_code)}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 shrink-0 text-ink-3">研判</span>
          <BriefStepLine step={run.brief} />
          {run.brief !== null && run.brief.duration_ms !== null && <span className="num text-ink-3">耗时 {ms(run.brief.duration_ms)}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 shrink-0 text-ink-3">日报评论</span>
          <CommentStepLine step={run.comment} />
          {run.comment !== null && run.comment.duration_ms !== null && <span className="num text-ink-3">耗时 {ms(run.comment.duration_ms)}</span>}
        </div>
      </div>
    </>
  );
}

export default function CareerAdmin({ loaderData }: Route.ComponentProps) {
  const { overview, unavailable: failed } = loaderData;
  return (
    <AdminPage
      title="就业数据"
      subtitle={
        overview
          ? `采集 / LLM 兜底 / 研判 / 日报评论的运行状态（只读）· 快照 ${bj(overview.generated_at)}`
          : "采集 / LLM 兜底 / 研判 / 日报评论的运行状态（只读）"
      }
    >
      {failed || overview === null ? (
        <Card title="数据暂不可用">
          <p className="py-6 text-center text-[13px] text-ink-3">
            就业数据的后台接口暂时读不到（未接线或数据库不可用）。页面其它部分不受影响，稍后刷新重试。
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-5">
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card title="采集运行" right={<span>最近 {overview.ingest.ok ? overview.ingest.data.runs.length : 0} 次</span>} pad={false} scrollable>
              {!overview.ingest.ok ? (
                <SectionEmpty />
              ) : (
                <DataTable
                  dense
                  rows={overview.ingest.data.runs}
                  rowKey={(run) => run.id}
                  empty="还没有采集记录"
                  columns={[
                    { key: "at", label: "时间", render: (run) => <Time at={run.fetched_at} /> },
                    { key: "s", label: "来源", render: (run) => run.source_label },
                    { key: "k", label: "类型", render: (run) => KIND_LABEL[run.kind] ?? run.kind },
                    {
                      key: "st",
                      label: "状态",
                      render: (run) => {
                        const status = INGEST_STATUS[run.status] ?? INGEST_STATUS.failed!;
                        return <Badge tone={status.tone} title={run.error ?? undefined}>{status.label}</Badge>;
                      },
                    },
                    { key: "n", label: "新增", align: "right", render: (run) => num(run.accepted) },
                    { key: "u", label: "更新", align: "right", render: (run) => num(run.updated) },
                    { key: "d", label: "重复", align: "right", render: (run) => num(run.duplicates) },
                    { key: "r", label: "拒绝", align: "right", render: (run) => num(run.rejected) },
                    { key: "e", label: "错误", render: (run) => <span className="line-clamp-2 text-[12px] text-ink-3" title={run.error ?? ""}>{run.error ?? "—"}</span> },
                  ]}
                />
              )}
            </Card>
            <Card title="来源健康" right={<span>按来源最近一次运行</span>} pad={false} scrollable>
              {!overview.sources.ok ? (
                <SectionEmpty />
              ) : (
                <DataTable
                  dense
                  rows={overview.sources.data}
                  rowKey={(source) => `${source.kind}:${source.source_key}`}
                  empty="还没有来源运行记录"
                  columns={[
                    { key: "s", label: "来源", render: (source) => source.source_label },
                    { key: "k", label: "类型", render: (source) => KIND_LABEL[source.kind] ?? source.kind },
                    {
                      key: "st",
                      label: "最近状态",
                      render: (source) => {
                        const status = INGEST_STATUS[source.last_status] ?? INGEST_STATUS.failed!;
                        return <Badge tone={status.tone} title={source.last_error ?? undefined}>{status.label}</Badge>;
                      },
                    },
                    { key: "at", label: "最近抓取", render: (source) => <Time at={source.last_fetched_at} /> },
                    {
                      key: "ok",
                      label: "最近成功",
                      render: (source) => (
                        <span className="whitespace-nowrap">
                          <Time at={source.last_ok_at} />
                          {source.last_ok_accepted !== null && <span className="ml-1 text-ink-3">新增 {num(source.last_ok_accepted)}</span>}
                        </span>
                      ),
                    },
                    { key: "f", label: "失败次数", align: "right", render: (source) => num(source.failed_runs) },
                    { key: "e", label: "最近错误", render: (source) => <span className="line-clamp-2 text-[12px] text-ink-3" title={source.last_error ?? ""}>{source.last_error ?? "—"}</span> },
                  ]}
                />
              )}
            </Card>
          </div>

          <Card title="LLM 兜底（最近一次每日任务）" right={<span>采集 → 兜底 → 研判 → 日报评论</span>}>
            <JobRunCard section={overview.llm} />
          </Card>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card title="最近研判（career_briefs）" pad={false} scrollable>
              {!overview.briefs.ok ? (
                <SectionEmpty />
              ) : (
                <DataTable
                  dense
                  rows={overview.briefs.data}
                  rowKey={(brief) => `${brief.prompt_version}:${brief.as_of}`}
                  empty="还没有研判缓存"
                  columns={[
                    { key: "v", label: "提示版本", render: (brief) => <span className="font-mono text-[11.5px] text-ink-3">{brief.prompt_version}</span> },
                    { key: "at", label: "数据截止", render: (brief) => <span className="num whitespace-nowrap">{bj(brief.as_of)}</span> },
                    { key: "c", label: "置信度", render: (brief) => confidence(brief.confidence) },
                    { key: "n", label: "样本", align: "right", render: (brief) => num(brief.sample_size) },
                    { key: "w", label: "观察窗", align: "right", render: (brief) => `${num(brief.window_days)} 天 / ${num(brief.observation_days)} 观测日` },
                    { key: "r", label: "回执", align: "right", render: (brief) => (brief.receipt_id === null ? "—" : `#${brief.receipt_id}`) },
                    { key: "g", label: "生成时间", render: (brief) => <Time at={brief.generated_at} /> },
                  ]}
                />
              )}
            </Card>
            <Card title="最近日报评论（career_daily_comments）" pad={false} scrollable>
              {!overview.comments.ok ? (
                <SectionEmpty />
              ) : (
                <DataTable
                  dense
                  rows={overview.comments.data}
                  rowKey={(comment) => `${comment.prompt_version}:${comment.date}`}
                  empty="还没有日报评论缓存"
                  columns={[
                    { key: "d", label: "日期", render: (comment) => <span className="num whitespace-nowrap">{comment.date}</span> },
                    { key: "v", label: "提示版本", render: (comment) => <span className="font-mono text-[11.5px] text-ink-3">{comment.prompt_version}</span> },
                    { key: "c", label: "置信度", render: (comment) => confidence(comment.confidence) },
                    { key: "n", label: "样本", align: "right", render: (comment) => num(comment.sample_size) },
                    { key: "j", label: "新增", align: "right", render: (comment) => num(comment.new_jobs) },
                    { key: "r", label: "回执", align: "right", render: (comment) => (comment.receipt_id === null ? "—" : `#${comment.receipt_id}`) },
                    { key: "g", label: "生成时间", render: (comment) => <Time at={comment.generated_at} /> },
                  ]}
                />
              )}
            </Card>
          </div>

          <Card title="数据规模与新鲜度">
            {!overview.scale.ok ? (
              <SectionEmpty />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
                  <Stat label="岗位" value={num(overview.scale.data.jobs)} />
                  <Stat label="观测" value={num(overview.scale.data.observations)} />
                  <Stat label="政策" value={num(overview.scale.data.policies)} />
                  <Stat label="研判缓存" value={num(overview.scale.data.briefs)} />
                  <Stat label="日报评论" value={num(overview.scale.data.comments)} />
                  <Stat label="观测日" value={num(overview.scale.data.observed_days)} hint="可出日报的天数" />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line pt-3 text-[12.5px] text-ink-3">
                  <span>最近岗位观测：<Time at={overview.scale.data.latest_job_seen_at} /></span>
                  <span>最近政策观测：<Time at={overview.scale.data.latest_policy_seen_at} /></span>
                  <span>最新政策发布：{overview.scale.data.latest_policy_published_at ?? "—"}</span>
                  <span>最近一次观测：<Time at={overview.scale.data.latest_observation_at} /></span>
                </div>
              </>
            )}
          </Card>
        </div>
      )}
    </AdminPage>
  );
}
