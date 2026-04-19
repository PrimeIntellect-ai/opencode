import { describe, expect, test } from "bun:test"
import type { NamedError } from "@opencode-ai/util/error"
import { APICallError } from "ai"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"

function apiError(headers?: Record<string, string>): MessageV2.APIError {
  return new MessageV2.APIError({
    message: "boom",
    isRetryable: true,
    responseHeaders: headers,
  }).toObject() as MessageV2.APIError
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { data: { message } } as ReturnType<NamedError["toObject"]>
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("sleep caps delay to max 32-bit signed integer to avoid TimeoutOverflowWarning", async () => {
    const controller = new AbortController()

    const warnings: string[] = []
    const originalWarn = process.emitWarning
    process.emitWarning = (warning: string | Error) => {
      warnings.push(typeof warning === "string" ? warning : warning.message)
    }

    const promise = SessionRetry.sleep(2_560_914_000, controller.signal)
    controller.abort()

    try {
      await promise
    } catch {}

    process.emitWarning = originalWarn
    expect(warnings.some((w) => w.includes("TimeoutOverflowWarning"))).toBe(false)
  })
})

describe("session.retry.retryable", () => {
  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error)).toBe("Provider is overloaded")
  })

  test("handles json messages without code", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error)).toBe(`{"error":{"message":"no_kv_space"}}`)
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("does not retry context overflow errors", () => {
    const error = new MessageV2.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject() as ReturnType<NamedError["toObject"]>

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("does not retry rollout lifecycle conflict responses", () => {
    const error = new MessageV2.APIError({
      message: "Conflict: Rollout reached max turns",
      statusCode: 409,
      isRetryable: true,
      metadata: {
        url: "https://gateway.example/v1/rollouts/rollout_abc/chat/completions",
      },
    }).toObject() as MessageV2.APIError

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await Bun.sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID: "test" })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
      expect((result as MessageV2.APIError).data.message).toBe("Connection reset by server")
      expect((result as MessageV2.APIError).data.metadata?.code).toBe("ECONNRESET")
      expect((result as MessageV2.APIError).data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = new MessageV2.APIError({
      message: "Connection reset by server",
      isRetryable: true,
      metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
    }).toObject() as MessageV2.APIError

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Connection reset by server")
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: "openai" }) as MessageV2.APIError
    expect(result.data.isRetryable).toBe(true)
  })
})

describe("session.retry.redactUrl", () => {
  test("redacts common secret query parameters", () => {
    const url = "https://api.example.com/v1/chat?api_key=sk-live-abc123&model=gpt-4"
    const out = SessionRetry.redactUrl(url)!
    expect(out).toContain("api_key=%5BREDACTED%5D")
    expect(out).not.toContain("sk-live-abc123")
    expect(out).toContain("model=gpt-4")
  })

  test("redacts authorization, token, bearer, x-api-key, access_token", () => {
    const url =
      "https://api.example.com/v1?authorization=xxx&token=yyy&x-api-key=zzz&access_token=aaa&bearer=bbb"
    const out = SessionRetry.redactUrl(url)!
    expect(out).not.toContain("xxx")
    expect(out).not.toContain("yyy")
    expect(out).not.toContain("zzz")
    expect(out).not.toContain("aaa")
    expect(out).not.toContain("bbb")
  })

  test("redacts userinfo in url", () => {
    const url = "https://user:pass@api.example.com/v1/chat"
    const out = SessionRetry.redactUrl(url)!
    expect(out).not.toContain("pass")
    expect(out).toContain("%5BREDACTED%5D")
  })

  test("returns original string when url is unparseable", () => {
    expect(SessionRetry.redactUrl("not a url")).toBe("not a url")
  })

  test("passes through undefined", () => {
    expect(SessionRetry.redactUrl(undefined)).toBeUndefined()
  })
})

describe("session.retry.redactBody", () => {
  test("redacts api_key in JSON-ish bodies", () => {
    const body = '{"model":"gpt-4","api_key":"sk-live-abc123"}'
    const out = SessionRetry.redactBody(body)!
    expect(out).not.toContain("sk-live-abc123")
    expect(out).toContain("[REDACTED]")
    expect(out).toContain("gpt-4")
  })

  test("redacts bearer tokens", () => {
    const body = "Authorization: Bearer sk-proj-abcdef1234567890"
    const out = SessionRetry.redactBody(body)!
    expect(out).not.toContain("sk-proj-abcdef1234567890")
    expect(out).toContain("Bearer [REDACTED]")
  })

  test("caps body length", () => {
    const body = "x".repeat(2000)
    const out = SessionRetry.redactBody(body)!
    expect(out.length).toBe(SessionRetry.STDERR_BODY_SNIPPET_MAX)
  })
})

describe("session.retry.dumpRetryExhaust", () => {
  const originalWrite = process.stderr.write.bind(process.stderr)

  function captureStderr(fn: () => void): string {
    let captured = ""
    // @ts-expect-error override write for test
    process.stderr.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      return true
    }
    try {
      fn()
    } finally {
      process.stderr.write = originalWrite
    }
    return captured
  }

  test("writes a grep-friendly prefix with retry metadata", () => {
    const error = new MessageV2.APIError({
      message: "upstream overloaded",
      statusCode: 503,
      isRetryable: true,
      responseBody: '{"error":"overloaded"}',
      metadata: { url: "https://api.example.com/v1/chat" },
    }).toObject() as MessageV2.APIError

    const line = captureStderr(() => {
      SessionRetry.dumpRetryExhaust({ error, attempt: 2, retryLimit: 2, sessionID: "ses_test" })
    })

    expect(line.startsWith("[retry-exhaust] ")).toBe(true)
    expect(line).toContain('"attempt":2')
    expect(line).toContain('"retryLimit":2')
    expect(line).toContain('"statusCode":503')
    expect(line).toContain('"sessionID":"ses_test"')
    expect(line).toContain('"upstream overloaded"')
    expect(line).toContain("https://api.example.com/v1/chat")
  })

  test("redacts secrets from url and body in stderr output", () => {
    const error = new MessageV2.APIError({
      message: "boom",
      statusCode: 500,
      isRetryable: true,
      responseBody: '{"api_key":"sk-secret-xyz","note":"hi"}',
      metadata: { url: "https://api.example.com/v1/chat?api_key=sk-secret-xyz" },
    }).toObject() as MessageV2.APIError

    const line = captureStderr(() => {
      SessionRetry.dumpRetryExhaust({ error, attempt: 2, retryLimit: 2 })
    })

    expect(line).not.toContain("sk-secret-xyz")
    expect(line).toContain("[REDACTED]")
  })
})

describe("session.message-v2.TerminalRetryExhaustedError", () => {
  test("is tagged with the expected discriminator name", () => {
    const e = new MessageV2.TerminalRetryExhaustedError({
      message: "gave up",
      attempts: 2,
      retryLimit: 2,
      underlyingName: "APIError",
      statusCode: 503,
    })
    const obj = e.toObject()
    expect(obj.name).toBe("TerminalRetryExhaustedError")
    expect(MessageV2.TerminalRetryExhaustedError.isInstance(obj)).toBe(true)
    expect(obj.data.attempts).toBe(2)
    expect(obj.data.retryLimit).toBe(2)
    expect(obj.data.underlyingName).toBe("APIError")
    expect(obj.data.statusCode).toBe(503)
  })
})
