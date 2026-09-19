import "server-only";
import type { AssistantConfig } from "@/shared/lib/config";

/**
 * Assistant provider adapters.
 *
 * The orchestrator depends on this interface only, so an authorised Impiricus
 * integration can be dropped in without touching retrieval, grounding, safety
 * or the UI.
 */

export interface ProviderMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionInput {
  system: string;
  messages: ProviderMessage[];
  maxOutputTokens: number;
  timeoutMs: number;
}

export type CompletionResult =
  | { ok: true; text: string }
  | { ok: false; reason: "timeout" | "rate-limited" | "upstream-error" | "not-configured"; detail: string };

export interface AssistantAdapter {
  id: string;
  /** Short label shown to the user so they know what produced the answer. */
  displayName: string;
  complete(input: CompletionInput): Promise<CompletionResult>;
}

/* ----------------------------------------------------------------- helpers */

/** One bounded retry, only for transient failures. */
async function withRetry(fn: () => Promise<CompletionResult>): Promise<CompletionResult> {
  const first = await fn();
  if (first.ok) return first;
  if (first.reason === "not-configured") return first;
  // Retry once for transient classes only.
  if (first.reason === "timeout" || first.reason === "rate-limited") {
    await new Promise((r) => setTimeout(r, 750));
    return fn();
  }
  return first;
}

/* --------------------------------------------------------------- anthropic */

function anthropicAdapter(config: AssistantConfig): AssistantAdapter {
  return {
    id: "anthropic",
    displayName: "Claude",
    async complete(input) {
      if (!config.apiKey) {
        return { ok: false, reason: "not-configured", detail: "ANTHROPIC_API_KEY is not set" };
      }
      return withRetry(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), input.timeoutMs);
        try {
          const res = await fetch(`${config.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": config.apiKey!,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: config.model,
              max_tokens: input.maxOutputTokens,
              system: input.system,
              messages: input.messages,
              temperature: 0,
            }),
            signal: controller.signal,
          });

          if (res.status === 429) {
            return { ok: false, reason: "rate-limited", detail: "Upstream rate limit" };
          }
          if (!res.ok) {
            // Deliberately does not include the response body, which could echo
            // request content into logs.
            return { ok: false, reason: "upstream-error", detail: `HTTP ${res.status}` };
          }

          const json: unknown = await res.json();
          const text = extractAnthropicText(json);
          if (!text) {
            return { ok: false, reason: "upstream-error", detail: "Empty completion" };
          }
          return { ok: true, text };
        } catch (err) {
          const isAbort = err instanceof Error && err.name === "AbortError";
          return {
            ok: false,
            reason: isAbort ? "timeout" : "upstream-error",
            detail: isAbort ? `Timed out after ${input.timeoutMs}ms` : "Network error",
          };
        } finally {
          clearTimeout(timer);
        }
      });
    },
  };
}

function extractAnthropicText(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const content = (json as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  const text = parts.join("\n").trim();
  return text.length > 0 ? text : null;
}

/* --------------------------------------------------------------- impiricus */

/**
 * Placeholder for an authorised Impiricus assistant integration.
 *
 * This is an independent prototype. No Impiricus endpoint, schema or credential
 * is known to this codebase, and none is invented here. The adapter exists so
 * that a documented integration can be implemented behind this interface, with
 * audience/scope checks applied in getAssistantConfig() before it is selected.
 */
function impiricusAdapter(_config: AssistantConfig): AssistantAdapter {
  return {
    id: "impiricus",
    displayName: "Impiricus assistant",
    async complete() {
      return {
        ok: false,
        reason: "not-configured",
        detail:
          "No documented Impiricus integration is available to this prototype. " +
          "Implement this adapter against the official specification before enabling it.",
      };
    },
  };
}

/* ---------------------------------------------------------------- selector */

export function getAdapter(config: AssistantConfig): AssistantAdapter | null {
  switch (config.provider) {
    case "anthropic":
      return anthropicAdapter(config);
    case "impiricus":
      return impiricusAdapter(config);
    case "none":
      return null;
  }
}
