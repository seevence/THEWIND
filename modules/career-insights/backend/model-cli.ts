// 通用「以子进程跑 node CLI」封装：每日管线各步骤的 CLI 契约一致——stdout 最后一行是结构化 JSON 汇总，
// 人读日志与失败说明走 stderr。这里只负责起进程、超时、收集输出和逐行解析，不关心汇总的字段；
// 各步骤（LLM 兜底、就业研判）的汇总形状与超时由调用方给出。
import { execFile } from "node:child_process";
import path from "node:path";

/** 仓库根：cron 以子进程在仓库根目录执行 scripts/ 下的 CLI。 */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export interface ModelCliOptions {
  /** 相对仓库根或绝对的脚本路径。 */
  script: string;
  args?: readonly string[];
  env: NodeJS.ProcessEnv;
  /** 整个子进程的超时；到点杀掉并按 timedOut 返回，不 reject。 */
  timeoutMs: number;
  cwd?: string;
  maxBuffer?: number;
}

export interface ModelCliOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 超时被杀：code 为 null，输出仍是已收集到的部分。 */
  timedOut?: boolean;
}

/** 启动失败（ENOENT 等拿不到退出码的错误）才 reject；超时与正常退出码都按结果返回。 */
export function runModelCli(options: ModelCliOptions): Promise<ModelCliOutcome> {
  const script = path.isAbsolute(options.script) ? options.script : path.join(REPO_ROOT, options.script);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script, ...(options.args ?? [])],
      {
        cwd: options.cwd ?? REPO_ROOT,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const failure = error as { code?: string | number | null; killed?: boolean };
        if (failure.killed === true) {
          resolve({ code: null, stdout: String(stdout), stderr: String(stderr), timedOut: true });
          return;
        }
        if (typeof failure.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: failure.code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * 从 stdout 里倒着找第一条能解析成 JSON 且被 accept 接受的 line：CLI 自己的 console.log、坏行、
 * 汇总之后的其它输出都不影响结果。汇总约定在最后一行，倒序找对它更宽容。
 */
export function parseLastJsonLine<T = unknown>(stdout: string, accept?: (value: unknown) => boolean): T | null {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let value: unknown;
    try {
      value = JSON.parse(lines[index]!);
    } catch {
      continue;
    }
    if (accept === undefined || accept(value)) return value as T;
  }
  return null;
}
