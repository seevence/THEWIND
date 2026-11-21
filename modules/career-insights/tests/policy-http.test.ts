// The policy list is a new public route: these tests drive the Fastify layer with a fake repository
// so query validation and error mapping are proven without a database.
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerCareerHttp } from "../backend/http.ts";
import { DataUnavailableError } from "../backend/errors.ts";
import type { CareerRepository } from "../backend/repository.ts";
import type { PolicyFiltersV1, PolicyListResponseV1 } from "../backend/policy-read.ts";

function policyResponse(filters: PolicyFiltersV1): PolicyListResponseV1 {
  return {
    contract_version: "0.1",
    data_origin: "live",
    as_of: "2026-11-18T00:00:00.000Z",
    items: [],
    page: filters.page,
    page_size: filters.page_size,
    total: 0,
    filters,
    facets: { sources: [], themes: [] },
  };
}

function fakeRepository(overrides: Partial<CareerRepository> = {}): CareerRepository {
  return {
    summary: async () => {
      throw new Error("not used");
    },
    listJobs: async () => {
      throw new Error("not used");
    },
    jobDetail: async () => null,
    jobAvailability: async () => ({ contract_version: "0.1", ids: {} }),
    listPolicies: async (filters) => policyResponse(filters),
    hotCompanies: async () => {
      throw new Error("not used");
    },
    dailySummary: async () => {
      throw new Error("not used");
    },
    careerSignals: async () => {
      throw new Error("not used");
    },
    careerCatalog: async () => {
      throw new Error("not used");
    },
    careerBrief: async () => {
      throw new Error("not used");
    },
    careerDailyComment: async () => {
      throw new Error("not used");
    },
    writeBatch: async () => ({ accepted: 0, updated: 0, duplicates: 0, rejected: 0, errors: [] }),
    ...overrides,
  };
}

async function build(repository: CareerRepository) {
  const app = Fastify();
  registerCareerHttp(app, repository);
  await app.ready();
  return app;
}

test("the policy route passes the parsed filters to the repository", async () => {
  let seen: PolicyFiltersV1 | undefined;
  const app = await build(fakeRepository({ listPolicies: async (filters) => ((seen = filters), policyResponse(filters)) }));
  const response = await app.inject({
    url: "/api/site/career-insights/policies?source_key=ndrc-policy&theme=employment_promotion&page=2&page_size=5",
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, { source_key: "ndrc-policy", theme: "employment_promotion", page: 2, page_size: 5 });
  assert.equal(response.headers["cache-control"], "public, max-age=60, stale-while-revalidate=300");
});

test("the policy route rejects unsupported and malformed parameters", async () => {
  const app = await build(fakeRepository());

  const unsupported = await app.inject({ url: "/api/site/career-insights/policies?sort=date" });
  assert.equal(unsupported.statusCode, 400);
  assert.equal(unsupported.json().error.code, "invalid_parameter");

  const tooLarge = await app.inject({ url: "/api/site/career-insights/policies?page_size=101" });
  assert.equal(tooLarge.statusCode, 400);

  const empty = await app.inject({ url: "/api/site/career-insights/policies?theme=" });
  assert.equal(empty.statusCode, 400);

  const unknownSource = await app.inject({ url: "/api/site/career-insights/policies?source_key=not-a-source" });
  assert.equal(unknownSource.statusCode, 400);
  assert.equal(unknownSource.json().error.code, "invalid_parameter");

  const unknownTheme = await app.inject({ url: "/api/site/career-insights/policies?theme=not-a-theme" });
  assert.equal(unknownTheme.statusCode, 400);

  const pageTooLarge = await app.inject({ url: "/api/site/career-insights/policies?page=10001" });
  assert.equal(pageTooLarge.statusCode, 400);

  const pageOverflow = await app.inject({ url: "/api/site/career-insights/policies?page=9007199254740991" });
  assert.equal(pageOverflow.statusCode, 400);

  for (const pageSize of [0, 1000]) {
    const response = await app.inject({ url: `/api/site/career-insights/policies?page_size=${pageSize}` });
    assert.equal(response.statusCode, 400, `page_size=${pageSize}`);
  }

  for (const theme of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const response = await app.inject({ url: `/api/site/career-insights/policies?theme=${theme}` });
    assert.equal(response.statusCode, 400, `theme=${theme}`);
    assert.equal(response.json().error.code, "invalid_parameter", `theme=${theme}`);
  }

  await app.close();
});

test("the jobs route rejects page and page_size outside the bounds", async () => {
  const app = await build(fakeRepository());
  for (const query of ["page=10001", "page=9007199254740991", "page_size=0", "page_size=1000"]) {
    const response = await app.inject({ url: `/api/site/career-insights/jobs?${query}` });
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().error.code, "invalid_parameter", query);
  }
  await app.close();
});

test("the policy route maps a database outage to 503 data_unavailable", async () => {
  const app = await build(
    fakeRepository({
      listPolicies: async () => {
        throw new DataUnavailableError();
      },
    }),
  );
  const response = await app.inject({ url: "/api/site/career-insights/policies" });
  await app.close();

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "data_unavailable");
});