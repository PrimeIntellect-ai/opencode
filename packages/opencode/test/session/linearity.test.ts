import { describe, expect, test } from "bun:test"
import { SystemPrompt } from "../../src/session/system"

describe("MITO linearity", () => {
  describe("system prompt stability", () => {
    test("environment() does not contain 'Today's date:'", async () => {
      // SystemPrompt.environment requires Instance to be initialized, so we check
      // the source directly — the date line was removed from system.ts
      const source = await Bun.file(
        new URL("../../src/session/system.ts", import.meta.url).pathname,
      ).text()
      expect(source).not.toContain("Today's date")
      expect(source).not.toContain("toDateString")
    })

    test("provider() returns stable output across calls", () => {
      const model = {
        api: { id: "claude-sonnet-4-20250514" },
      } as any
      const first = SystemPrompt.provider(model)
      const second = SystemPrompt.provider(model)
      expect(first).toEqual(second)
    })
  })

  describe("text content preservation", () => {
    test("processor does not trimEnd text content", async () => {
      const source = await Bun.file(
        new URL("../../src/session/processor.ts", import.meta.url).pathname,
      ).text()
      // Neither text-end nor reasoning-end should trimEnd
      expect(source).not.toContain("trimEnd()")
    })
  })

  describe("tool call repair does not lowercase", () => {
    test("experimental_repairToolCall does not lowercase tool names", async () => {
      const source = await Bun.file(
        new URL("../../src/session/llm.ts", import.meta.url).pathname,
      ).text()
      // The lowercasing branch should be removed
      expect(source).not.toContain("toolName.toLowerCase()")
    })
  })
})
