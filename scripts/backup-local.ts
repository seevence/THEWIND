// 本地数据库备份（不依赖对象存储）：pg_dump --format=custom 到 <AIHOT_DATA_DIR>/backups/<UTC 时间戳>.dump，
// 只保留最近 N 份（默认 7）。对象存储备份（packages/backend/src/operations/backup.ts，ops.backup）没有
// DB_BACKUP_STORE_* 时不会注册；这个脚本用本机 pg_dump 兜底，适合比赛/演示和小站，也用于恢复演练。
//
// 用法：
//   node scripts/backup-local.ts
//   node scripts/backup-local.ts --database-url postgres://user:pass@127.0.0.1:5432/aihot
//   node scripts/backup-local.ts --keep 14 --dir /var/backups/aihot
// 连接串也可以放 DATABASE_URL；AIHOT_DATA_DIR 默认仓库下的 .data（与运行时一致）。
// 只清理本脚本自己命名的 <时间戳>.dump，不碰同一目录里引擎备份写的 <库名>-<时间戳>.dump。
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const DEFAULT_KEEP = 7;
export const DEFAULT_DATABASE_URL = "postgres://127.0.0.1:5432/aihot";
/** 本脚本写出的备份名：UTC 时间戳，例如 20261121T063012Z.dump。 */
export const DUMP_NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/;

export interface BackupOptions {
  help: boolean;
  databaseUrl: string;
  keep: number;
  dir: string;
}

/** 本地备份目录：默认 <AIHOT_DATA_DIR>/backups，与引擎本地备份同处（但文件名不同，互不干扰）。 */
export function backupsDir(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = env.AIHOT_DATA_DIR ? path.resolve(env.AIHOT_DATA_DIR) : path.resolve(import.meta.dirname, "..", ".data");
  return path.join(dataDir, "backups");
}

export function parseBackupArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): BackupOptions {
  const options: BackupOptions = {
    help: false,
    databaseUrl: env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL,
    keep: DEFAULT_KEEP,
    dir: backupsDir(env),
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
    else if (arg === "--keep") {
      const keep = Number(value());
      if (!Number.isInteger(keep) || keep < 1) throw new Error("--keep 必须是大于 0 的整数");
      options.keep = keep;
    } else if (arg === "--dir") options.dir = path.resolve(value());
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

/** UTC 时间戳，写到秒：同一秒内两次备份会覆盖同名文件，这是有意的（保留策略按名字排序）。 */
export function backupStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** 只挑本脚本写出的备份，新的在前；保留最新 keep 份，其余删除。 */
export function selectBackups(names: readonly string[], keep: number): { keep: string[]; remove: string[] } {
  const dumps = names.filter((name) => DUMP_NAME.test(name)).sort().reverse();
  return { keep: dumps.slice(0, keep), remove: dumps.slice(keep) };
}

/**
 * libpq 的账号密码从环境变量传，不放在命令行：argv 会出现在进程列表里，失败时也会被记进 job_runs。
 * URL 里其余连接参数（sslmode 等）原样保留。
 */
export function pgEnvironment(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): { url: string; env: NodeJS.ProcessEnv } {
  const connection = new URL(databaseUrl);
  const out: NodeJS.ProcessEnv = { ...env };
  if (connection.username) out.PGUSER = decodeURIComponent(connection.username);
  if (connection.password) out.PGPASSWORD = decodeURIComponent(connection.password);
  connection.username = connection.password = "";
  connection.search = connection.search.slice(1).split("&").filter((option) => {
    if (option === "") return false;
    const separator = option.indexOf("=");
    const key = decodeURIComponent(option.slice(0, separator));
    if (key !== "user" && key !== "password") return true;
    out[key === "user" ? "PGUSER" : "PGPASSWORD"] = decodeURIComponent(option.slice(separator + 1));
    return false;
  }).join("&");
  return { url: connection.href, env: out };
}

async function prune(dir: string, keep: number): Promise<string[]> {
  const { remove } = selectBackups(await readdir(dir), keep);
  for (const name of remove) await rm(path.join(dir, name), { force: true });
  return remove;
}

function usage(): string {
  return [
    "本地备份数据库（pg_dump 自定义格式），保留最近 N 份。",
    "",
    "用法：node scripts/backup-local.ts [--database-url <连接串>] [--keep <份数>] [--dir <目录>]",
    "",
    "  --database-url  默认取 DATABASE_URL，再默认 postgres://127.0.0.1:5432/aihot",
    `  --keep          保留最近多少份，默认 ${DEFAULT_KEEP}，至少 1`,
    `  --dir           备份目录，默认 <AIHOT_DATA_DIR>/backups（AIHOT_DATA_DIR 默认仓库下的 .data）`,
    "",
    "恢复：node scripts/restore-local.ts <dump 文件> --database-url <连接串> --yes",
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseBackupArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  await mkdir(options.dir, { recursive: true });
  const file = path.join(options.dir, `${backupStamp(new Date())}.dump`);
  const connection = pgEnvironment(options.databaseUrl);
  console.log(`备份数据库到 ${file} ...`);
  try {
    await run("pg_dump", ["--format=custom", "--compress=6", "--no-owner", "--file", file, connection.url], {
      env: connection.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    // 和引擎备份一样先验证归档能列出：坏归档等到恢复时才发现就晚了。
    await run("pg_restore", ["--list", file], { maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
  const size = (await stat(file)).size;
  const removed = await prune(options.dir, options.keep);
  console.log(`备份完成：${file}（${size} 字节），保留最近 ${options.keep} 份`);
  for (const name of removed) console.log(`已清理旧备份：${name}`);
  console.log(`恢复演练/恢复：node scripts/restore-local.ts ${file} --database-url <连接串> --restore-into <库名> --confirm <库名> --yes`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`备份失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
