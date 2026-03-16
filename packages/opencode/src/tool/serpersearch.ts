import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./serpersearch.txt"
import { abortAfterAny } from "../util/abort"

const NUM_RESULTS_PER_QUERY = 5

interface SerperResponse {
  knowledgeGraph?: {
    title?: string
    description?: string
    attributes?: Record<string, string>
  }
  organic?: Array<{
    title?: string
    link?: string
    snippet?: string
  }>
  peopleAlsoAsk?: Array<{
    question?: string
    snippet?: string
  }>
}

function formatSerperResults(data: SerperResponse, query: string): string {
  const sections: string[] = []

  const kg = data.knowledgeGraph
  if (kg) {
    const kgLines: string[] = []
    const title = kg.title?.trim()
    if (title) kgLines.push(`Knowledge Graph: ${title}`)
    const description = kg.description?.trim()
    if (description) kgLines.push(description)
    const attributes = kg.attributes ?? {}
    for (const [key, value] of Object.entries(attributes)) {
      const text = String(value).trim()
      if (text) kgLines.push(`${key}: ${text}`)
    }
    if (kgLines.length) sections.push(kgLines.join("\n"))
  }

  for (const [index, result] of (data.organic ?? []).slice(0, NUM_RESULTS_PER_QUERY).entries()) {
    const title = result.title?.trim() || "Untitled"
    const lines = [`Result ${index}: ${title}`]
    const link = result.link?.trim()
    if (link) lines.push(`URL: ${link}`)
    const snippet = result.snippet?.trim()
    if (snippet) lines.push(snippet)
    sections.push(lines.join("\n"))
  }

  const peopleAlsoAsk = data.peopleAlsoAsk ?? []
  if (peopleAlsoAsk.length) {
    const maxQuestions = Math.max(1, Math.min(3, peopleAlsoAsk.length))
    const questions: string[] = []
    for (const item of peopleAlsoAsk.slice(0, maxQuestions)) {
      const question = item.question?.trim()
      if (!question) continue
      let entry = `Q: ${question}`
      const answer = item.snippet?.trim()
      if (answer) entry += `\nA: ${answer}`
      questions.push(entry)
    }
    if (questions.length) sections.push("People Also Ask:\n" + questions.join("\n"))
  }

  if (!sections.length) return `No results returned for query: ${query}`

  return sections.join("\n\n---\n\n")
}

async function fetchSerperSearch(query: string, apiKey: string, signal: AbortSignal): Promise<string> {
  const response = await fetch("https://google.serper.dev/search", {
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

  const data: SerperResponse = await response.json()
  return formatSerperResults(data, query)
}

export const SerperSearchTool = Tool.define("serpersearch", async () => {
  return {
    get description() {
      return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
    },
    parameters: z.object({
      queries: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe(
          "Google search queries (up to 10). Use multiple queries to search different angles in parallel.",
        ),
    }),
    async execute(params, ctx) {
      const apiKey = process.env.SERPER_API_KEY
      if (!apiKey) {
        throw new Error("SERPER_API_KEY environment variable is not set")
      }

      await ctx.ask({
        permission: "serpersearch",
        patterns: params.queries,
        always: ["*"],
        metadata: { queries: params.queries },
      })

      const { signal, clearTimeout } = abortAfterAny(45000, ctx.abort)

      try {
        const results = await Promise.all(
          params.queries.slice(0, 10).map((query) => fetchSerperSearch(query, apiKey, signal)),
        )

        clearTimeout()

        const output = results
          .map((result, i) => {
            const query = params.queries[i]
            return `Results for query "${query}":\n\n${result}`
          })
          .join("\n\n---\n\n")

        return {
          output,
          title: `Google Search (${params.queries.length} ${params.queries.length === 1 ? "query" : "queries"})`,
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
