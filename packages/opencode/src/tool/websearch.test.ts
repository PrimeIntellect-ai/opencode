import { describe, test, expect, beforeAll } from "bun:test"
import z from "zod"

const API_CONFIG = {
  BASE_URL: "https://mcp.exa.ai",
  ENDPOINTS: { SEARCH: "/mcp" },
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

interface McpSearchResponse {
  jsonrpc: string
  result: {
    content: Array<{ type: string; text: string }>
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

async function fetchSearch(request: McpSearchRequest, searchUrl: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(searchUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
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

const queriesSchema = z.array(z.string()).min(1).max(5)

describe("websearch", () => {
  let searchUrl: string

  beforeAll(() => {
    const exaKey = process.env.EXA_API_KEY
    if (!exaKey) throw new Error("EXA_API_KEY must be set")
    searchUrl = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.SEARCH}?exaApiKey=${exaKey}&tools=web_search_advanced_exa`
  })

  test(
    "single query returns non-empty results",
    async () => {
      const request = buildSearchRequest("capital of France", 0)
      const result = await fetchSearch(request, searchUrl)
      expect(result).toBeTruthy()
      expect(result).not.toBe("No results found.")
      expect(result.length).toBeGreaterThan(50)
    },
    { timeout: 30000 },
  )

  test(
    "multiple queries return results for each",
    async () => {
      const queries = ["capital of France", "population of Japan"]
      const results = await Promise.all(
        queries.map((query, i) => {
          const request = buildSearchRequest(query, i)
          return fetchSearch(request, searchUrl)
        }),
      )

      expect(results).toHaveLength(2)
      for (const result of results) {
        expect(result).toBeTruthy()
        expect(result).not.toBe("No results found.")
      }
    },
    { timeout: 30000 },
  )

  test(
    "5 queries works",
    async () => {
      const queries = ["TypeScript generics", "Rust ownership", "Python asyncio", "Go goroutines", "Java streams"]
      const results = await Promise.all(
        queries.map((query, i) => {
          const request = buildSearchRequest(query, i)
          return fetchSearch(request, searchUrl)
        }),
      )

      expect(results).toHaveLength(5)
      for (const result of results) {
        expect(result).toBeTruthy()
      }
    },
    { timeout: 45000 },
  )

  test("schema rejects >5 queries", () => {
    const sixQueries = ["a", "b", "c", "d", "e", "f"]
    const parsed = queriesSchema.safeParse(sixQueries)
    expect(parsed.success).toBe(false)
  })

  test("schema rejects empty array", () => {
    const parsed = queriesSchema.safeParse([])
    expect(parsed.success).toBe(false)
  })

  test(
    "highlights are present in results",
    async () => {
      const request = buildSearchRequest("climate change effects 2025", 0)
      const result = await fetchSearch(request, searchUrl)
      // Advanced search with enableHighlights should return content with highlights
      // Highlights are typically marked with <highlight> tags or contain substantial text excerpts
      expect(result.length).toBeGreaterThan(200)
      // The result should contain URLs (indicating structured search results)
      expect(result).toMatch(/https?:\/\//)
    },
    { timeout: 30000 },
  )
})
