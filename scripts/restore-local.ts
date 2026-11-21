// 从 backup-local.ts 的 dump 恢复数据库：pg_restore --clean --if-exists 覆盖目标库。
//
// 安全设计（2026-11-21 演练事故后加固）：只加 --yes 不再够用——
//   --restore-into <库名>  显式指定目标库（没有默认值），必须与 --database-url 的库名一致；
//   --confirm <库名>       与 --restore-into 完全一致，防止把预览命令复制一遍随手加 --yes；
//   生产库名（aihot / postgres / template*）默认拒绝，确需恢复生产库再加 --allow-production。
// 不加 --yes 只预览、不执行；错误信息里会写出正确的恢复目标示例。
//
// 用法：
//   node scripts/restore-local.ts <dump> --database-url postgres://.../aihot_restore_check \
//     --restore-into aihot_restore_check --confirm aihot_restore_check --yes
//   正式库恢复（危险）：
//   node scripts/restore-local.ts <dump> --database-url postgres://.../aihot \
//     --restore-into aihot --confirm aihot --allow-production --yes
//
// 目标库必须已存在；恢复不会创建数据库。演练请先建临时库（如 xxx_restore_check）。
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_DATABASE_URL, pgEnvironment } from "./backup-local.ts";

const run = promisify(execFile);

/** 默认拒绝恢复的库名：正式库与 Postgres 自带的模板库。 */
export const PRODUCTION_DATABASES: ReadonlySet<string> = new Set(["aihot", "postgres", "template0", "template1"]);

export interface RestoreOptions {
  help: boolean;
  dump: string | null;
  databaseUrl: string;
  restoreInto: string | null;
  confirm: string | null;
  allowProduction: boolean;
  yes: boolean;
}

export function parseRestoreArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): RestoreOptions {
  const options: RestoreOptions = {
    help: false,
    dump: null,
    databaseUrl: env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL,
    restoreInto: null,
    confirm: null,
    allowProduction: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} 需要一个值`);
      return next;
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--database-url") options.databaseUrl = value();
    else if (arg === "--restore-into") options.restoreInto = value();
    else if (arg === "--confirm") options.confirm = value();
    else if (arg === "--allow-production") options.allowProduction = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg.startsWith("--")) throw new Error(`未知参数：${arg}`);
    else if (options.dump !== null) throw new Error(`只能指定一个 dump 文件（已有 ${options.dump}，又给了 ${arg}）`);
    else options.dump = arg;
  }
  return options;
}

export function databaseName(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, "")) || "(默认库)";
}

/**
 * 校验恢复目标：目标库必须显式给出、与连接串一致；确认执行（--yes）时还要求
 * --confirm 同名，生产库名再要求 --allow-production。返回目标库名。
 */
export function validateRestoreTarget(options: RestoreOptions): string {
  const target = options.restoreInto?.trim() ?? "";
  if (target === "") throw new Error("必须用 --restore-into <库名> 显式指定目标库（没有默认值）。");
  if (!/^[A-Za-z0-9_]+$/.test(target) || target.length > 63) throw new Error(`目标库名不合法：${target}`);
  let connected: string;
  try {
    connected = databaseName(options.databaseUrl);
  } catch {
    throw new Error("--database-url 不是合法的连接串。");
  }
  if (connected !== target) {
    throw new Error(`--database-url 的库名（${connected}）与 --restore-into（${target}）不一致；恢复不会换库。`);
  }
  if (!options.yes) return target;
  if (options.confirm !== target) throw new Error(`--yes 还需要 --confirm ${target} 再确认一次目标库。`);
  if (PRODUCTION_DATABASES.has(target.toLowerCase()) && !options.allowProduction) {
    throw new Error(`拒绝恢复生产库 ${target}：确需恢复请加 --allow-production，并先确认备份文件。`);
  }
  return target;
}

function usage(): string {
  return [
    "从本地备份恢复数据库（pg_restore --clean --if-exists），会覆盖目标库。",
    "",
    "用法：node scripts/restore-local.ts <dump 文件> --database-url <连接串> --restore-into <库名> [--confirm <库名>] [--allow-production] [--yes]",
    "",
    "  --database-url     默认取 DATABASE_URL，再默认 postgres://127.0.0.1:5432/aihot",
    "  --restore-into     必填：目标库名，且必须与连接串里的库名一致（没有默认值）",
    "  --confirm          与 --restore-into 同名；加 --yes 时必须提供",
    "  --allow-production 允许恢复 aihot / postgres 等生产库名；默认拒绝",
    "  --yes              确认执行；不加时只显示将要恢复的库和文件，什么都不改",
    "",
    "演练示例（把备份恢复到临时库，确认无误后删库）：",
    "  node scripts/restore-local.ts .data/backups/x.dump --database-url postgres://127.0.0.1:5432/aihot_restore_check --restore-into aihot_restore_check --confirm aihot_restore_check --yes",
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseRestoreArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.dump === null) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const dump = path.resolve(options.dump);
  const info = await stat(dump).catch(() => null);
  if (info === null || !info.isFile()) {
    console.error(`找不到备份文件：${dump}`);
    process.exitCode = 1;
    return;
  }
  let target: string;
  try {
    target = validateRestoreTarget(options);
  } catch (error) {
    console.error(`恢复已拒绝：${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  console.log(`将把 ${dump}（${info.size} 字节）恢复到数据库 ${target}，--clean --if-exists 会覆盖同名对象。`);
  if (!options.yes) {
    console.log("未执行：确认目标库无误后，按上面的用法加 --confirm 与 --yes 再运行。");
    return;
  }
  const connection = pgEnvironment(options.databaseUrl);
  await run("pg_restore", ["--clean", "--if-exists", "--no-owner", "--dbname", connection.url, dump], {
    env: connection.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  console.log(`恢复完成：${dump} -> ${target}。请检查关键表的行数与应用的 /api/health。`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
