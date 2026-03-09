import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./websearch.txt"
import { abortAfterAny } from "../util/abort"

const API_CONFIG = {
  BASE_URL: "https://mcp.exa.ai",
  ENDPOINTS: {
    SEARCH: "/mcp",
  },
  NUM_RESULTS_PER_QUERY: 5,
} as const

interface McpSearchRequest {
  jsonrpc: string
  id: number
  method: string
  params: {
    name: string
    arguments: {
      query: string
      numResults: number
      livecrawl: "fallback"
      type: "auto"
      enableHighlights: boolean
      highlightsPerUrl: number
    }
  }
}

interface McpSearchResponse {
  jsonrpc: string
  result: {
    content: Array<{
      type: string
      text: string
    }>
  }
}

function buildSearchRequest(query: string, id: number): McpSearchRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "web_search_advanced_exa",
      arguments: {
        query,
        type: "auto",
        numResults: API_CONFIG.NUM_RESULTS_PER_QUERY,
        livecrawl: "fallback",
        enableHighlights: true,
        highlightsPerUrl: 2,
      },
    },
  }
}

function parseSearchResponse(responseText: string): string | undefined {
  const lines = responseText.split("\n")
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data: McpSearchResponse = JSON.parse(line.substring(6))
      if (data.result?.content?.length > 0) {
        return data.result.content[0].text
      }
    }
  }
  return undefined
}

async function fetchSearch(
  request: McpSearchRequest,
  searchUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(searchUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Search error (${response.status}): ${errorText}`)
  }

  const responseText = await response.text()
  return parseSearchResponse(responseText) ?? "No results found."
}

export const WebSearchTool = Tool.define("websearch", async () => {
  return {
    get description() {
      return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
    },
    parameters: z.object({
      queries: z
        .array(z.string())
        .min(1)
        .max(5)
        .describe("Search queries (up to 5). Use multiple queries to search different angles in parallel."),
    }),
    async execute(params, ctx) {
      await ctx.ask({
        permission: "websearch",
        patterns: params.queries,
        always: ["*"],
        metadata: { queries: params.queries },
      })

      const headers: Record<string, string> = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      }

      const exaKey = process.env.EXA_API_KEY
      const searchUrl = exaKey
        ? `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.SEARCH}?exaApiKey=${exaKey}&tools=web_search_advanced_exa`
        : `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.SEARCH}?tools=web_search_advanced_exa`

      const { signal, clearTimeout } = abortAfterAny(45000, ctx.abort)

      try {
        const results = await Promise.all(
          params.queries.slice(0, 5).map((query, i) => {
            const request = buildSearchRequest(query, i)
            return fetchSearch(request, searchUrl, headers, signal)
          }),
        )

        clearTimeout()

        const output = results
          .map((result, i) => {
            const query = params.queries[i]
            return `## Query: ${query}\n\n${result}`
          })
          .join("\n\n---\n\n")

        return {
          output,
          // title is UI-only, not shown to model
          title: `Web search (${params.queries.length} ${params.queries.length === 1 ? "query" : "queries"})`,
          metadata: {},
        }
      } catch (error) {
        clearTimeout()

        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Search request timed out")
        }

        throw error
      }
    },
  }
})
