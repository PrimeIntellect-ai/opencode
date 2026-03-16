import { describe, test, expect, beforeAll } from "bun:test"
import z from "zod"

const SERPER_URL = "https://google.serper.dev/search"

let apiKey: string

async function fetchSerperSearch(query: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(SERPER_URL, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query }),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Serper search error (${response.status}): ${errorText}`)
  }

  return response.json()
}

const queriesSchema = z.array(z.string()).min(1).max(10)

describe("serpersearch", () => {
  beforeAll(() => {
    const key = process.env.SERPER_API_KEY
    if (!key) throw new Error("SERPER_API_KEY must be set")
    apiKey = key
  })

  test(
    "single query returns non-empty results with URLs",
    async () => {
      const data = await fetchSerperSearch("capital of France")
      expect(data.organic).toBeDefined()
      expect(data.organic.length).toBeGreaterThan(0)
      expect(data.organic[0].link).toMatch(/https?:\/\//)
    },
    { timeout: 30000 },
  )

  test(
    "multiple queries return results for each",
    async () => {
      const queries = ["capital of France", "population of Japan"]
      const results = await Promise.all(queries.map((q) => fetchSerperSearch(q)))

      expect(results).toHaveLength(2)
      for (const data of results) {
        expect(data.organic).toBeDefined()
        expect(data.organic.length).toBeGreaterThan(0)
      }
    },
    { timeout: 30000 },
  )

  test(
    "10 queries works",
    async () => {
      const queries = [
        "TypeScript generics",
        "Rust ownership",
        "Python asyncio",
        "Go goroutines",
        "Java streams",
        "C++ templates",
        "Kotlin coroutines",
        "Swift protocols",
        "Ruby blocks",
        "Elixir processes",
      ]
      const results = await Promise.all(queries.map((q) => fetchSerperSearch(q)))

      expect(results).toHaveLength(10)
      for (const data of results) {
        expect(data.organic).toBeDefined()
        expect(data.organic.length).toBeGreaterThan(0)
      }
    },
    { timeout: 60000 },
  )

  test("schema rejects >10 queries", () => {
    const elevenQueries = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]
    const parsed = queriesSchema.safeParse(elevenQueries)
    expect(parsed.success).toBe(false)
  })

  test("schema rejects empty array", () => {
    const parsed = queriesSchema.safeParse([])
    expect(parsed.success).toBe(false)
  })

  test(
    "results contain organic data with title/URL/snippet",
    async () => {
      const data = await fetchSerperSearch("climate change effects 2025")
      expect(data.organic).toBeDefined()
      expect(data.organic.length).toBeGreaterThan(0)
      const first = data.organic[0]
      expect(first.title).toBeTruthy()
      expect(first.link).toMatch(/https?:\/\//)
      expect(first.snippet).toBeTruthy()
    },
    { timeout: 30000 },
  )
})
