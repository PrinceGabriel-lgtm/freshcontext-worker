import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── FreshContext envelope ────────────────────────────────────────────────────
function stamp(content, sourceUrl, contentDate, adapter) {
  return [
    `[FRESHCONTEXT]`,
    `Source: ${sourceUrl}`,
    `Published: ${contentDate ?? "unknown"}`,
    `Retrieved: ${new Date().toISOString()}`,
    `Confidence: ${contentDate ? "high" : "medium"}`,
    `Adapter: ${adapter}`,
    `---`,
    content,
    `[/FRESHCONTEXT]`,
  ].join("\n");
}

// ── Browser Rendering REST API helper ────────────────────────────────────────
async function browserFetch(env, endpoint, url) {
  const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/browser-rendering/${endpoint}`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.CF_API_TOKEN}`,
    },
    body: JSON.stringify({ url, rejectResourceTypes: ["image", "font"] }),
  });
  if (!res.ok) throw new Error(`Browser Rendering API error: ${res.status} ${await res.text()}`);
  return res;
}

// ── MCP Agent ────────────────────────────────────────────────────────────────
export class FreshContextAgent extends McpAgent {
  server = new McpServer({ name: "freshcontext-mcp", version: "0.1.0" });

  async init() {

    // extract_github
    this.server.tool("extract_github",
      { url: z.string().url(), max_length: z.number().optional().default(6000) },
      async ({ url, max_length }) => {
        const res = await browserFetch(this.env, "scrape", url);
        const data = await res.json();

        const elements = data.result || [];
        const find = (sel) => elements.find(e => e.selector === sel)?.text ?? null;

        const readme = elements.find(e =>
          e.selector?.includes("readme") || e.selector?.includes("markdown-body")
        )?.text ?? "No README found";

        const raw = [
          `URL: ${url}`,
          `README excerpt:\n${readme}`,
        ].join("\n").slice(0, max_length);

        // Use markdown endpoint for better content
        const mdRes = await browserFetch(this.env, "markdown", url);
        const mdData = await mdRes.json();
        const markdown = (mdData.result || "").slice(0, max_length);

        return { content: [{ type: "text", text: stamp(markdown || raw, url, null, "github") }] };
      }
    );

    // extract_scholar
    this.server.tool("extract_scholar",
      { url: z.string().url(), max_length: z.number().optional().default(6000) },
      async ({ url, max_length }) => {
        const res = await browserFetch(this.env, "markdown", url);
        const data = await res.json();
        const content = (data.result || "No results found").slice(0, max_length);

        // Try to find a year in the content
        const yearMatch = content.match(/\b(19|20)\d{2}\b/g);
        const years = yearMatch ? [...new Set(yearMatch)].sort().reverse() : [];
        const contentDate = years[0] ? `${years[0]}-01-01` : null;

        return { content: [{ type: "text", text: stamp(content, url, contentDate, "google_scholar") }] };
      }
    );

    // extract_hackernews
    this.server.tool("extract_hackernews",
      { url: z.string().url(), max_length: z.number().optional().default(4000) },
      async ({ url, max_length }) => {
        const res = await browserFetch(this.env, "markdown", url);
        const data = await res.json();
        const content = (data.result || "No results found").slice(0, max_length);

        // HN timestamps are ISO format in the page
        const dateMatch = content.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        const contentDate = dateMatch ? dateMatch[0] : null;

        return { content: [{ type: "text", text: stamp(content, url, contentDate, "hackernews") }] };
      }
    );
  }
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      return FreshContextAgent.mount("/mcp").fetch(request, env, ctx);
    }
    return new Response("freshcontext-mcp is running", { status: 200 });
  }
};
