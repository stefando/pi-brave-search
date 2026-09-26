/**
 * pi-brave-search — web search via the Brave LLM Context API.
 *
 * Deliberately minimal (v0.2):
 * - ONE tool: brave_search
 * - ONE key:  macOS keychain entry (service "pi-brave-search", account
 *   "brave-api-key") — never a plain file on disk
 * - no fallbacks, no caching, no curation — failures surface as plain errors
 *   so you can see exactly what went wrong
 *
 * Non-negotiables inherited from real-world use:
 * 1. the key is read at call time — rotate it in the keychain, no restart
 * 2. the key is redacted from every error message (Brave echoes the
 *    X-Subscription-Token back in some error bodies) and is never shown
 *    by any command or status output
 * 3. hard 30s timeout + caller abort propagation
 * 4. no key in keychain → loud, actionable failure (no silent env fallback)
 *
 * Roadmap (see README): domain filters, responseId storage for full content.
 */

import { execFileSync } from "node:child_process";

import { Text } from "@earendil-works/pi-tui";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

// ─── Configuration ──────────────────────────────────────────────────────────

const BRAVE_LLM_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context";
const TIMEOUT_MS = 30_000;
const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 5;
/** Cap per-source extracted text so one long page can't blow the context. */
const MAX_CONTENT_CHARS = 8_000;

const KEYCHAIN_SERVICE = "pi-brave-search";
const KEYCHAIN_ACCOUNT = "brave-api-key";

/** Our recencyFilter values → Brave's `freshness` codes. */
const FRESHNESS: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

// ─── Tool parameters ────────────────────────────────────────────────────────

/**
 * The tool's parameters, described with TypeBox (the schema library Pi's
 * registerTool expects). Each `Type.*` call builds a plain JSON Schema object
 * at runtime — Pi sends it to the LLM as the tool definition — and TypeScript
 * derives the matching static type from it (see SearchParams below).
 */
const Params = Type.Object({
  query: Type.String({ description: "Search query" }),
  numResults: Type.Optional(
    Type.Number({
      description: `Number of results, 1-${MAX_RESULTS} (default ${DEFAULT_RESULTS})`,
    }),
  ),
  includeContent: Type.Optional(
    Type.Boolean({
      description:
        "Request more of Brave's query-relevant extracted chunks per source (raises the token budget; more context usage)",
    }),
  ),
  recencyFilter: Type.Optional(
    Type.Union(
      [
        Type.Literal("day"),
        Type.Literal("week"),
        Type.Literal("month"),
        Type.Literal("year"),
      ],
      {
        description: "Only include results from this time period",
      },
    ),
  ),
});

/**
 * The TypeScript type of the parameters, derived from the schema above:
 * { query: string; numResults?: number; includeContent?: boolean;
 *   recencyFilter?: "day" | "week" | "month" | "year" }
 */
type SearchParams = Static<typeof Params>;

// ─── Brave API response shape ───────────────────────────────────────────────

/** The subset of the Brave LLM Context response that we read. */
interface BraveResponse {
  grounding?: { generic?: BraveGroundingSource[] };
}

interface BraveGroundingSource {
  url?: string;
  title?: string;
  snippets?: string[];
}

/** Metadata attached to each tool result, for Pi's rendering and state. */
interface BraveDetails {
  provider: "brave-llm-context";
  query: string;
  resultCount: number;
}

// ─── Extension entry point ──────────────────────────────────────────────────

/** Pi calls this once when loading the extension. */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "brave_search",
    label: "Brave Search",
    description:
      "Search the web via the Brave LLM Context API. Returns ranked, pre-extracted content " +
      "chunks for the top URLs — ready to synthesize without further fetching. " +
      "Use includeContent=true when you need more than the leading snippet per source.",
    parameters: Params,

    /** Runs each time the LLM calls the tool. */
    async execute(_toolCallId, params: SearchParams, signal?: AbortSignal) {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new Error(keychainSetupInstructions());
      }

      const query = params.query.trim();
      if (query === "") {
        throw new Error("brave_search: query must not be empty");
      }
      // `??` falls back to the default when numResults was not given;
      // then clamp to 1..MAX_RESULTS.
      const numResults = Math.max(
        1,
        Math.min(Math.floor(params.numResults ?? DEFAULT_RESULTS), MAX_RESULTS),
      );

      const url = new URL(BRAVE_LLM_CONTEXT_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(numResults));
      url.searchParams.set("maximum_number_of_urls", String(numResults));
      // LLM Context API is token-budgeted: small budget for snippets,
      // larger budget when the caller wants the extracted content.
      url.searchParams.set(
        "maximum_number_of_tokens",
        params.includeContent ? "16384" : "4096",
      );
      if (params.recencyFilter) {
        url.searchParams.set("freshness", FRESHNESS[params.recencyFilter]);
      }

      // Abort on whichever comes first: our timeout or the caller cancelling.
      const signals = [AbortSignal.timeout(TIMEOUT_MS)];
      if (signal) {
        signals.push(signal);
      }

      try {
        const response = await fetch(url, {
          headers: {
            "X-Subscription-Token": apiKey,
            Accept: "application/json",
          },
          signal: AbortSignal.any(signals),
        });

        if (!response.ok) {
          const body = await response.text();
          // Redact FIRST, then truncate: truncating first could cut a full
          // echoed key into a fragment that no longer matches for redaction.
          const safe = redact(body, apiKey);
          throw new Error(
            `Brave API error ${response.status}: ${safe.slice(0, 300)}`,
          );
        }

        // json() is untyped; we assert the shape we expect (not checked at runtime,
        // hence the optional fields and the `?.` / `??` guards below).
        const data = (await response.json()) as BraveResponse;
        const sources = (data.grounding?.generic ?? [])
          .filter((s) => s.url)
          .slice(0, numResults);
        return buildResult(query, sources, params.includeContent === true);
      } catch (err) {
        // Never let the key leak into the error the agent (or a log) sees.
        const message = err instanceof Error ? err.message : String(err);
        const redacted = redact(message, apiKey);
        if (redacted !== message) {
          throw new Error(redacted);
        }
        throw err;
      }
    },

    /** How the call is shown in Pi's terminal UI. */
    renderCall(args: { query?: string }, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("brave_search ")) +
          theme.fg("muted", `"${args.query ?? ""}"`),
        0,
        0,
      );
    },

    /** How the result is shown in Pi's terminal UI. */
    renderResult(result, _exp, theme) {
      const text = result.content[0];
      if (text?.type === "text") {
        return new Text(theme.fg("text", text.text), 0, 0);
      }
      return new Text("", 0, 0);
    },
  });

  pi.registerCommand("brave-status", {
    description: "Show brave_search configuration status",
    handler: async (_args, ctx) => {
      // Boolean check only — no part of the key is ever displayed.
      const configured = getApiKey() !== null;
      if (configured) {
        ctx.ui.notify(
          `brave_search: configured (key in macOS keychain)`,
          "info",
        );
      } else {
        ctx.ui.notify(
          "brave_search: NOT configured — see the error text of a brave_search call",
          "warning",
        );
      }
    },
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read the key from the macOS keychain at call time.
 * Returns null when the entry does not exist, the keychain is locked,
 * or we are not on macOS (in which case the tool fails loudly).
 */
function getApiKey(): string | null {
  try {
    const out = execFileSync(
      "security",
      [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim() !== "" ? out.trim() : null;
  } catch {
    return null;
  }
}

function keychainSetupInstructions(): string {
  return (
    `brave_search is not configured: no keychain entry (service "${KEYCHAIN_SERVICE}", ` +
    `account "${KEYCHAIN_ACCOUNT}"). Store a key with:
` +
    `  security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -U -w
` +
    `(-w is last on purpose: it makes security prompt for the key at a hidden prompt, ` +
    `so it never lands in shell history or process args; ` +
    `-U replaces an existing entry, so the same command also rotates it). ` +
    `Get a key at https://brave.com/search/api/. ` +
    `The first read after storing may prompt for keychain access (choose "Always Allow").`
  );
}

function redact(text: string, key: string | null): string {
  return key ? text.split(key).join("[REDACTED_API_KEY]") : text;
}

/** Format the sources as the plain-text result the LLM reads. */
function buildResult(
  query: string,
  sources: BraveGroundingSource[],
  includeContent: boolean,
): AgentToolResult<BraveDetails> {
  const details: BraveDetails = {
    provider: "brave-llm-context",
    query,
    resultCount: sources.length,
  };

  if (sources.length === 0) {
    return {
      content: [{ type: "text", text: `No results for "${query}"` }],
      details,
    };
  }

  const lines: string[] = [`${sources.length} source(s) for "${query}":`, ""];
  let index = 0;
  for (const source of sources) {
    index += 1;
    const title = source.title || source.url || "";
    lines.push(`${index}. ${title}`);
    lines.push(`   ${source.url}`);
    const snippets = source.snippets ?? [];
    // Each snippet exactly once: the leading chunk alone (default) or all
    // chunks combined (includeContent) — capped to MAX_CONTENT_CHARS.
    const combined = includeContent
      ? snippets.join("\n\n")
      : (snippets[0] ?? "");
    if (combined) {
      const bounded =
        combined.length > MAX_CONTENT_CHARS
          ? `${combined.slice(0, MAX_CONTENT_CHARS)}\n   [content truncated at ${MAX_CONTENT_CHARS} chars]`
          : combined;
      lines.push(`   ${bounded}`);
    }
    lines.push("");
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details,
  };
}
