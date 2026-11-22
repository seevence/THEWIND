// 一次性规则回填：把既有岗位里 role_family="unknown" 的行，按最新标题关键词词典重新归类。
// 纯规则、不调用模型；只改 role_family 与 updated_at，不动观测与其它派生字段。
// node scripts/reclassify-role-family-rules.ts            dry-run，只打印统计
// node scripts/reclassify-role-family-rules.ts --apply    写库
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import postgres from "postgres";
import { resolveRoleFamily } from "../modules/career-insights/data/normalize.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const envFile = path.join(REPO_ROOT, ".env");
if (existsSync(envFile)) {
  const parsed = parseEnv(readFileSync(envFile, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const apply = process.argv.includes("--apply");
const url = process.env.DATABASE_URL?.trim();
if (!url) { console.error("缺少 DATABASE_URL"); process.exit(2); }
const sql = postgres(url, { max: 4, idle_timeout: 5 });
const BATCH = 200;

try {
  const rows = await sql<Array<{ id: string; title: string }>>`
    SELECT id, title FROM career_jobs WHERE role_family = 'unknown' ORDER BY updated_at DESC
  `;
  const counts = new Map<string, number>();
  const targets: Array<{ id: string; role: string }> = [];
  for (const row of rows) {
    const role = resolveRoleFamily(undefined, row.title);
    if (role === "unknown") continue;
    counts.set(role, (counts.get(role) ?? 0) + 1);
    targets.push({ id: row.id, role });
  }
  console.log(`候选 ${rows.length} 行，规则可归类 ${targets.length} 行`);
  console.log([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
  if (apply) {
    let changed = 0;
    for (let i = 0; i < targets.length; i += BATCH) {
      const batch = targets.slice(i, i + BATCH);
      await sql.begin(async (tx) => {
        for (const item of batch) {
          await tx`UPDATE career_jobs SET role_family = ${item.role}, updated_at = now() WHERE id = ${item.id}`;
          changed += 1;
        }
      });
    }
    console.log(`已更新 ${changed} 行`);
  } else {
    console.log("dry-run（加 --apply 写库）");
  }
} finally {
  await sql.end({ timeout: 5 });
}
