import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeClock, SystemClock } from "../collector/fetch/clock.ts";
import { HostRateLimiter } from "../collector/fetch/rate-limiter.ts";
import { SourceBudget } from "../collector/fetch/budget.ts";
import { runWithRetry } from "../collector/fetch/retry.ts";
import { detectBlock } from "../collector/fetch/block-detector.ts";
import { HttpTransport } from "../collector/fetch/http-transport.ts";
import { createPageRequest } from "../collector/fetch/transport.ts";
import {
  AccessBlockedError,
  BudgetExhaustedError,
  ConfigError,
  RequestTimeoutError,
  SchemeDowngradeError,
} from "../collector/fetch/errors.ts";

function fakeSleep(clock: FakeClock) {
  return async (ms: number): Promise<void> => {
    clock.advance(ms);
  };
}

test("同一域名串行且上次结束到本次开始至少 1000ms", async () => {
  const clock = new FakeClock("2026-11-17T08:00:00.000Z");
  const limiter = new HostRateLimiter({ minIntervalMs: 1_000, clock, sleep: fakeSleep(clock) });
  const starts: number[] = [];
  let inFlight = 0;
  let peak = 0;

  for (let index = 0; index < 20; index += 1) {
    await limiter.schedule("talent.alibaba.com", async () => {
      starts.push(clock.monotonicMs());
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      clock.advance(10);
      inFlight -= 1;
    });
  }

  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(
      (starts[index] ?? 0) - (starts[index - 1] ?? 0) >= 1_000,
      "相邻请求间隔必须不小于 1000ms",
    );
  }
  assert.equal(peak, 1);
  assert.equal(limiter.stats("talent.alibaba.com").requests, 20);
});

test("两个来源指向同一域名时共享串行队列", async () => {
  const clock = new FakeClock("2026-11-17T08:00:00.000Z");
  const limiter = new HostRateLimiter({ minIntervalMs: 1_000, clock, sleep: fakeSleep(clock) });
  const order: string[] = [];
  await Promise.all([
    limiter.schedule("www.gov.cn", async () => {
      order.push("job");
    }),
    limiter.schedule("www.gov.cn", async () => {
      order.push("policy");
    }),
  ]);
  assert.deepEqual(order, ["job", "policy"]);
  assert.equal(limiter.stats("www.gov.cn").peakInFlight, 1);
});

test("单来源 15 分钟预算耗尽后抛出", () => {
  const clock = new FakeClock("2026-11-17T08:00:00.000Z");
  const budget = new SourceBudget({
    clock,
    totalMs: 900_000,
    sourceKey: "alibaba-official-careers",
    sleep: fakeSleep(clock),
  });
  clock.advance(900_000);
  assert.equal(budget.remainingMs(), 0);
  assert.throws(() => budget.assertRemaining(), BudgetExhaustedError);
});

test("等待被截断到剩余预算内", async () => {
  const clock = new FakeClock("2026-11-17T08:00:00.000Z");
  const budget = new SourceBudget({
    clock,
    totalMs: 900_000,
    sourceKey: "www.gov.cn",
    sleep: fakeSleep(clock),
  });
  clock.advance(899_600);
  assert.equal(await budget.sleepWithin(2_000), 400);
  assert.equal(budget.remainingMs(), 0);
});

test("超时最多重试 3 次，退避为 1s/2s/4s，总尝试 4 次", async () => {
  const delays: number[] = [];
  let attempts = 0;
  await assert.rejects(
    runWithRetry(
      async (attempt) => {
        attempts = attempt;
        throw new RequestTimeoutError();
      },
      {
        maxRetries: 3,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    ),
    RequestTimeoutError,
  );
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [1_000, 2_000, 4_000]);
});

test("不可重试的访问限制不重试", async () => {
  let attempts = 0;
  await assert.rejects(
    runWithRetry(
      async () => {
        attempts += 1;
        throw new AccessBlockedError("forbidden", "HTTP 403");
      },
      { maxRetries: 3, sleep: async () => undefined },
    ),
    AccessBlockedError,
  );
  assert.equal(attempts, 1);
});

test("429 只按 Retry-After 重试一次，超过 30s 直接停止", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  await assert.rejects(
    runWithRetry(
      async () => {
        attempts += 1;
        throw new AccessBlockedError("rate_limited", "HTTP 429");
      },
      {
        maxRetries: 3,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        retryAfter: () => 5_000,
      },
    ),
    AccessBlockedError,
  );
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [5_000]);

  await assert.rejects(
    runWithRetry(
      async () => {
        throw new AccessBlockedError("rate_limited", "HTTP 429");
      },
      { maxRetries: 3, sleep: async () => undefined, retryAfter: () => 60_000 },
    ),
    AccessBlockedError,
  );
});

test("预算耗尽时不等待直接终止", async () => {
  await assert.rejects(
    runWithRetry(
      async () => {
        throw new RequestTimeoutError();
      },
      {
        maxRetries: 3,
        sleep: async () => undefined,
        assertBudget: () => {
          throw new BudgetExhaustedError();
        },
      },
    ),
    BudgetExhaustedError,
  );
});

test("六类访问限制全部识别，正常页面不误判", () => {
  const base = {
    requestUrl: "https://talent.alibaba.com/jobs",
    finalUrl: "https://talent.alibaba.com/jobs",
    bodyText: "公开职位列表",
    sourceKey: "alibaba-official-careers",
  };
  assert.equal(detectBlock({ ...base, status: 401 })?.limitationType, "unauthorized");
  assert.equal(detectBlock({ ...base, status: 403 })?.limitationType, "forbidden");
  assert.equal(detectBlock({ ...base, status: 429 })?.limitationType, "rate_limited");
  assert.equal(
    detectBlock({ ...base, status: 200, bodyText: "请输入验证码" })?.limitationType,
    "captcha",
  );
  assert.equal(
    detectBlock({ ...base, status: 200, finalUrl: "https://talent.alibaba.com/login" })
      ?.limitationType,
    "login_required",
  );
  assert.equal(
    detectBlock({ ...base, status: 200, bodyText: "付费后查看全文" })?.limitationType,
    "paywall",
  );
  assert.equal(detectBlock({ ...base, status: 200 }), null);
});

test("单调时钟回拨视为配置错误", () => {
  const clock = new SystemClock();
  clock.monotonicMs();
  const original = Date.now;
  Date.now = () => 0;
  try {
    assert.throws(() => clock.monotonicMs(), ConfigError);
  } finally {
    Date.now = original;
  }
});
function redirect(location: string): Response {
  return {
    status: 302,
    headers: new Headers({ location }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

function bodyPage(): Response {
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    arrayBuffer: async () => new TextEncoder().encode("<html></html>").buffer,
  } as unknown as Response;
}

test("HTTPS 被重定向到 HTTP 时抛 SchemeDowngradeError，不静默接受降级", async () => {
  const fetchImpl = (async () => redirect("http://www.moe.gov.cn/jyb_xxgk/detail.html")) as unknown as typeof fetch;
  const transport = new HttpTransport({ fetchImpl });

  await assert.rejects(
    transport.fetchPage(
      createPageRequest({
        url: "https://www.moe.gov.cn/jyb_xxgk/detail.html",
        sourceKey: "moe-policy",
        pageTimeoutMs: 5_000,
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SchemeDowngradeError);
      assert.equal(error.failureType, "transport_security");
      assert.equal(error.limitationType, "scheme_downgrade");
      return true;
    },
  );
});

test("链式 https→http→https 在中间跳即被拦截，不会因为最终落点仍是 https 而放行", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const target = String(url);
    calls.push(target);
    if (target === "https://a.example/start") {
      return redirect("http://a.example/mid");
    }
    if (target === "http://a.example/mid") {
      return redirect("https://a.example/final");
    }
    return bodyPage();
  }) as unknown as typeof fetch;
  const transport = new HttpTransport({ fetchImpl });

  await assert.rejects(
    transport.fetchPage(
      createPageRequest({ url: "https://a.example/start", sourceKey: "demo", pageTimeoutMs: 5_000 }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SchemeDowngradeError);
      return true;
    },
  );
  assert.deepEqual(calls, ["https://a.example/start"]);
});

test("重定向到非 http(s) 协议时拒绝，不放行 file 等本地协议", async () => {
  const fetchImpl = (async () => redirect("file:///C:/secret.txt")) as unknown as typeof fetch;
  const transport = new HttpTransport({ fetchImpl });

  await assert.rejects(
    transport.fetchPage(
      createPageRequest({ url: "https://a.example/x", sourceKey: "demo", pageTimeoutMs: 5_000 }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SchemeDowngradeError);
      assert.match(error.message, /协议不受支持|重定向目标/);
      return true;
    },
  );
});

test("POST 请求体与 content-type 透传到底层 fetch", async () => {
  const captured: { init: RequestInit | null } = { init: null };
  const fetchImpl = (async (_url: string | URL | Request, init: RequestInit) => {
    captured.init = init;
    return bodyPage();
  }) as unknown as typeof fetch;
  const transport = new HttpTransport({ fetchImpl });

  await transport.fetchPage(
    createPageRequest({
      url: "https://zhaopin.meituan.com/api/official/job/getJobList",
      sourceKey: "meituan-official-careers",
      pageTimeoutMs: 5_000,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"page":{"pageNo":1,"pageSize":3}}',
    }),
  );

  assert.equal(captured.init?.method, "POST");
  assert.equal(captured.init?.body, '{"page":{"pageNo":1,"pageSize":3}}');
  assert.equal((captured.init?.headers as Record<string, string>)["content-type"], "application/json");
  assert.equal(captured.init?.redirect, "manual");
});

test("POST 遇到重定向时拒绝，不静默降级为 GET", async () => {
  const fetchImpl = (async () =>
    redirect("https://zhaopin.meituan.com/api/official/job/getJobList2")) as unknown as typeof fetch;
  const transport = new HttpTransport({ fetchImpl });

  await assert.rejects(
    transport.fetchPage(
      createPageRequest({
        url: "https://zhaopin.meituan.com/api/official/job/getJobList",
        sourceKey: "meituan-official-careers",
        pageTimeoutMs: 5_000,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.failureType, "config_error");
      return true;
    },
  );
});

test("跟随重定向后 TransportResponse.finalUrl 返回最终 URL 而不是初始 URL", async () => {
  const fetchImpl = (async (url: string | URL | Request) => {
    if (String(url) === "https://a.example/start") {
      return redirect("https://a.example/final");
    }
    return bodyPage();
  }) as unknown as typeof fetch;
  const transport = new HttpTransport({ fetchImpl });

  const response = await transport.fetchPage(
    createPageRequest({ url: "https://a.example/start", sourceKey: "demo", pageTimeoutMs: 5_000 }),
  );

  assert.equal(response.requestUrl, "https://a.example/start");
  assert.equal(response.finalUrl, "https://a.example/final");
});
