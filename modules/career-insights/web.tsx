import { defineWebModule } from "@aihot/web/modules";

export default defineWebModule({
  name: "career-insights",
  // /agent 页：MCP 的 4 个就业工具、公开 API v1 就业端点与三份 RSS（与 server 侧 agent.abilities 对应）。
  agent: () => import("./web/agent.tsx"),
});