import type { NamedError } from "@opencode-ai/util/error"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

  /**
   * Cap on the size of response-body snippets emitted to stderr when retry
   * budget is exhausted. Keeps the dump short enough for grep-friendly logs
   * while still preserving enough context to diagnose provider errors.
   */
  export const STDERR_BODY_SNIPPET_MAX = 500

  const SECRET_QUERY_KEYS = [
    "api_key",
    "apikey",
    "api-key",
    "x-api-key",
    "authorization",
    "auth",
    "token",
    "access_token",
    "accesstoken",
    "bearer",
    "key",
    "secret",
  ]

  function isTerminalRolloutConflict(error: MessageV2.APIError) {
    return error.data.statusCode === 409 && error.data.metadata?.url?.includes("/v1/rollouts/")
  }

  /**
   * Redact secret-looking values from a URL's query string and userinfo.
   * Returns the original string (unchanged) if the URL cannot be parsed -
   * this is a stderr logging helper, not a validator.
   */
  export function redactUrl(url: string | undefined): string | undefined {
    if (!url) return url
    try {
      const parsed = new URL(url)
      if (parsed.username || parsed.password) {
        parsed.username = "[REDACTED]"
        parsed.password = ""
      }
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (SECRET_QUERY_KEYS.some((s) => key.toLowerCase() === s)) {
          parsed.searchParams.set(key, "[REDACTED]")
        }
      }
      return parsed.toString()
    } catch {
      return url
    }
  }

  /**
   * Scrub secret-looking values from a body snippet. Best-effort: handles
   * common JSON-ish and key=value patterns without assuming structured input.
   */
  export function redactBody(body: string | undefined): string | undefined {
    if (!body) return body
    let out = body
    for (const key of SECRET_QUERY_KEYS) {
      // "key": "value" or 'key': 'value'
      const jsonRe = new RegExp(`(["']${key}["']\\s*:\\s*)(["'])([^"']*?)\\2`, "gi")
      out = out.replace(jsonRe, (_m, p1, q) => `${p1}${q}[REDACTED]${q}`)
      // key=value in query-style or headers
      const kvRe = new RegExp(`(${key}=)([^&\\s"']+)`, "gi")
      out = out.replace(kvRe, (_m, p1) => `${p1}[REDACTED]`)
    }
    // Bearer <token>
    out = out.replace(/(bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, (_m, p1) => `${p1}[REDACTED]`)
    return out.slice(0, STDERR_BODY_SNIPPET_MAX)
  }

  /**
   * Build and write the structured retry-exhaustion dump to process stderr.
   *
   * This must hit **process stderr** directly (not the opencode log file) so
   * that host sandboxes - notably the PrimeIntellect RL rollout harness -
   * capture the real underlying error via their `agent_stderr` channel.
   * Prefix is grep-friendly on purpose.
   */
  export function dumpRetryExhaust(input: {
    error: ReturnType<NamedError["toObject"]>
    attempt: number
    retryLimit: number
    sessionID?: string
  }): string {
    const { error, attempt, retryLimit } = input
    const data: any = error.data ?? {}
    const isAPI = MessageV2.APIError.isInstance(error)
    const url = isAPI ? redactUrl(data.metadata?.url) : undefined
    const statusCode = isAPI ? data.statusCode : undefined
    const body = isAPI ? redactBody(data.responseBody) : undefined
    const msg = typeof data.message === "string" ? data.message : undefined

    const payload: Record<string, unknown> = {
      name: error.name,
      attempt,
      retryLimit,
      ...(input.sessionID ? { sessionID: input.sessionID } : {}),
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(url ? { url } : {}),
      ...(msg ? { message: msg } : {}),
      ...(body ? { body } : {}),
    }
    const line = `[retry-exhaust] ${JSON.stringify(payload)}\n`
    process.stderr.write(line)
    return line
  }

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(
        () => {
          signal.removeEventListener("abort", abortHandler)
          resolve()
        },
        Math.min(ms, RETRY_MAX_DELAY),
      )
      signal.addEventListener("abort", abortHandler, { once: true })
    })
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return parsedMs
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return Math.ceil(parsedSeconds * 1000)
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return Math.ceil(parsed)
          }
        }

        return RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
      }
    }

    return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>) {
    // context overflow errors should not be retried
    if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
    if (MessageV2.APIError.isInstance(error)) {
      if (isTerminalRolloutConflict(error)) return undefined
      if (!error.data.isRetryable) return undefined
      if (error.data.responseBody?.includes("FreeUsageLimitError"))
        return `Free usage exceeded, add credits https://opencode.ai/zen`
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    const json = iife(() => {
      try {
        if (typeof error.data?.message === "string") {
          const parsed = JSON.parse(error.data.message)
          return parsed
        }

        return JSON.parse(error.data.message)
      } catch {
        return undefined
      }
    })
    try {
      if (!json || typeof json !== "object") return undefined
      const code = typeof json.code === "string" ? json.code : ""

      if (json.type === "error" && json.error?.type === "too_many_requests") {
        return "Too Many Requests"
      }
      if (code.includes("exhausted") || code.includes("unavailable")) {
        return "Provider is overloaded"
      }
      if (json.type === "error" && json.error?.code?.includes("rate_limit")) {
        return "Rate Limited"
      }
      return JSON.stringify(json)
    } catch {
      return undefined
    }
  }
}
