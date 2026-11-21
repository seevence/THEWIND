// 就业模块的模型步骤：注册进 engine 的 capabilities（后台“模型与评测”页据此显示/切换），以及脚本侧
// careerStepModel 的解析优先级（后台切换 > 环境变量 > site/models.ts DEFAULTS > default）。
// 不访问外部服务；需要库的路径用 fake db 覆盖。
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Db } from "@aihot/backend/db";
import { capabilities } from "@aihot/backend/editorial/models";
import { installModules } from "@aihot/backend/modules";
import { LLM_PURPOSE } from "../../../scripts/backfill-normalizer-llm.ts";
import { CAREER_MODEL_STEPS, careerStepModel, type CareerModelStep } from "../backend/models.ts";

const STEPS: CareerModelStep[] = ["career.brief", "career.daily-comment", "career.llm-normalize"];
const ENV_KEYS = ["CAREER_BRIEF_MODEL", "CAREER_DAILY_COMMENT_MODEL", "CAREER_LLM_NORMALIZE_MODEL"];

afterEach(() => {
  installModules([]);
  for (const key of ENV_KEYS) delete process.env[key];
});

test("三个 career 步骤注册成 engine 的模型步骤，默认值来自 site/models.ts", () => {
  assert.deepEqual(Object.keys(CAREER_MODEL_STEPS).sort(), [...STEPS].sort());
  installModules([{ name: "career-insights", models: CAREER_MODEL_STEPS }]);
  const steps = capabilities();
  assert.equal(steps["career.brief"]?.default, "default");
  assert.equal(steps["career.brief"]?.env, "CAREER_BRIEF_MODEL");
  assert.equal(steps["career.daily-comment"]?.default, "default");
  assert.equal(steps["career.llm-normalize"]?.env, "CAREER_LLM_NORMALIZE_MODEL");
  // 后台的用量统计按 purpose 聚合，兜底步骤的 purpose 必须与脚本实际传入的一致。
  assert.deepEqual(steps["career.llm-normalize"]?.purposes, [LLM_PURPOSE]);
  assert.deepEqual(steps["career.brief"]?.purposes, ["career-brief"]);
  assert.deepEqual(steps["career.daily-comment"]?.purposes, ["career-daily-comment"]);
});

test("步骤未配置时回退 site DEFAULTS：三个步骤都解析为 default", async () => {
  for (const step of STEPS) assert.equal(await careerStepModel(step), "default");
});

test("环境变量可逐步覆盖；未注册的模型名被忽略、回退默认", async () => {
  process.env.CAREER_BRIEF_MODEL = "qwen3.8-flash";
  assert.equal(await careerStepModel("career.brief"), "qwen3.8-flash");
  process.env.CAREER_BRIEF_MODEL = "not-a-registered-model";
  assert.equal(await careerStepModel("career.brief"), "default");
});

test("后台切换（settings.models.<step>）优先于环境变量，且忽略未注册的模型", async () => {
  process.env.CAREER_BRIEF_MODEL = "qwen3.8-flash";
  const switched = (async (strings: TemplateStringsArray) => {
    assert.match(strings.join("?"), /FROM settings/);
    return [{ value: { model: "glm-5.3-flash" } }];
  }) as unknown as Db;
  assert.equal(await careerStepModel("career.brief", switched), "glm-5.3-flash");

  const invalid = (async () => [{ value: { model: "not-a-registered-model" } }]) as unknown as Db;
  assert.equal(await careerStepModel("career.brief", invalid), "qwen3.8-flash");
});

test("读 settings 失败时回退环境变量/默认值，不阻断生成", async () => {
  const down = (async () => {
    throw new Error("database unavailable");
  }) as unknown as Db;
  assert.equal(await careerStepModel("career.daily-comment", down), "default");
  process.env.CAREER_DAILY_COMMENT_MODEL = "mimo-v2.6-flash";
  assert.equal(await careerStepModel("career.daily-comment", down), "mimo-v2.6-flash");
});
