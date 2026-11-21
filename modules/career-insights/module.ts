import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "career-insights",
  pages: [
    { path: "career-insights", file: "web/routes/dashboard.tsx" },
    { path: "career-insights/policies", file: "web/routes/policies.tsx" },
    { path: "career-insights/jobs", file: "web/routes/jobs-catalog.tsx" },
    { path: "career-insights/jobs/:id", file: "web/routes/job.tsx" },
  ],
  apiPaths: [/^\/api\/site\/career-insights(?:\/|$)/],
});