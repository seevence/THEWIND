// 就业模块注册给后台「模型与评测」的三个模型步骤，以及脚本侧的模型解析。
//
// 步骤名与 engine 的其它步骤同构：后台「模型与评测」页按能力名切换并把选择写进 settings 的
// models.<步骤>；解析顺序与 packages/backend/src/editorial/models.ts 的 modelFor 一致：
// 后台切换 > 环境变量 > site/models.ts 的 DEFAULTS > default。
//
// 接线：lead 在 modules/career-insights/server.ts 的 ServerModule 上加 models: CAREER_MODEL_STEPS，
// 后台模型页立即能看到并切换这三个步骤。
//
// 独立脚本（每日管线以子进程跑 scripts/build-career-*.ts、scripts/backfill-incremental-llm.ts）没有
// 安装模块，所以 careerStepModel 在模块未注册时自己按同一优先级解析；传了 db 时直接读 settings 的
// models.<步骤>，后台切换对次日管线生效。
import { MODELS } from "@aihot/backend/providers/llm";
import { serverModules, type ModelStep } from "@aihot/backend/modules";
import type { Db } from "@aihot/backend/db";
import { modelFor } from "@aihot/backend/editorial/models";
import { DEFAULTS } from "@aihot/site/models";
import { CAREER_BRIEF_PURPOSE } from "./brief.ts";
import { CAREER_DAILY_COMMENT_PURPOSE } from "./career-daily-comment.ts";

/** scripts/backfill-normalizer-llm.ts 的 LLM_PURPOSE；模块不反向 import scripts，这里同步一份。 */
const CAREER_LLM_NORMALIZE_PURPOSE = "career-normalize";

/**
 * 就业采集/研判/评论的模型步骤。label 出现在后台“模型与评测”页；purposes 用来聚合回执统计
 * （与调用 chatJson 时传的 purpose 一致）。
 */
export const CAREER_MODEL_STEPS = {
  "career.brief": {
    label: "就业研判（事实/推断/建议，中文输出）",
    env: "CAREER_BRIEF_MODEL",
    purposes: [CAREER_BRIEF_PURPOSE],
  },
  "career.daily-comment": {
    label: "就业日报 AI 评论（当日聚合，中文输出）",
    env: "CAREER_DAILY_COMMENT_MODEL",
    purposes: [CAREER_DAILY_COMMENT_PURPOSE],
  },
  "career.llm-normalize": {
    label: "岗位归一化兜底（职族、技能与学生友好度）",
    env: "CAREER_LLM_NORMALIZE_MODEL",
    purposes: [CAREER_LLM_NORMALIZE_PURPOSE],
  },
} satisfies Record<string, ModelStep>;

export type CareerModelStep = keyof typeof CAREER_MODEL_STEPS;

/** 模块是否已把步骤注册给 engine（api/worker 进程里为 true，独立脚本为 false）。 */
function stepRegistered(step: CareerModelStep): boolean {
  return serverModules().some((module) => module.models !== undefined && step in module.models);
}

/** settings 里后台切换的模型名；没有、或切到未注册的模型时返回 null。 */
async function switchedModel(db: Db, step: CareerModelStep): Promise<string | null> {
  const rows = await db<{ value: { model?: unknown } | null }[]>`
    SELECT value FROM settings WHERE key = ${'models.' + step}`;
  const model = rows[0]?.value?.model;
  return typeof model === "string" && MODELS[model] !== undefined ? model : null;
}

/**
 * 某个就业步骤现在该用的模型（返回 MODELS 的键，可直接传给 chatJson）。
 * 模块已注册时直接用 engine 统一的 modelFor；独立脚本按同一优先级自己解析：
 * settings 的后台切换 > 环境变量 > site/models.ts 的 DEFAULTS > default。
 * 读 settings 失败不阻断生成：退回环境变量/默认值。
 */
export async function careerStepModel(step: CareerModelStep, db?: Db): Promise<string> {
  if (stepRegistered(step)) {
    try {
      return await modelFor(step);
    } catch {
      // 进程里注册了模块但读不到设置（例如库暂不可用）：按脚本侧同一套规则退回。
    }
  }
  if (db !== undefined) {
    const switched = await switchedModel(db, step).catch(() => null);
    if (switched !== null) return switched;
  }
  const env = process.env[CAREER_MODEL_STEPS[step].env];
  if (env !== undefined && MODELS[env] !== undefined) return env;
  const fallback = DEFAULTS[step] ?? "default";
  return MODELS[fallback] !== undefined ? fallback : "default";
}
