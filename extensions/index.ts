/**
 * pi-brave-search — web search via the Brave LLM Context API.
 *
 * Deliberately minimal (v0.1):
 * - ONE tool: brave_search
 * - ONE key:  BRAVE_API_KEY environment variable (https://brave.com/search/api/)
 * - no fallbacks, no caching, no curation — failures surface as plain errors
 *   so you can see exactly what went wrong
 *
 * Three non-negotiables inherited from real-world use:
 * 1. the key is read at call time, so exporting a new key + restart works
 * 2. the key is redacted from every error message (Brave echoes the
 *    X-Subscription-Token back in some error bodies)
 * 3. hard 30s timeout + caller abort propagation
 *
 * Roadmap (see README): keychain key source, domain filters,
 * responseId storage for full content.
 */

import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BRAVE_LLM_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context";
const TIMEOUT_MS = 30_000;
const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 5;
/** Cap inline content per source so a single long page can't blow the context. */
const MAX_CONTENT_CHARS = 8_000;

const FRESHNESS: Record<string, string> = {
	day: "pd",
	week: "pw",
	month: "pm",
	year: "py",
};

const Params = Type.Object({
	query: Type.String({ description: "Search query" }),
	numResults: Type.Optional(Type.Number({ description: `Number of results, 1-${MAX_RESULTS} (default ${DEFAULT_RESULTS})` })),
	includeContent: Type.Optional(
		Type.Boolean({
			description:
				"Include the full pre-extracted page content for each source (uses a larger token budget; more context usage)",
		}),
	),
	recencyFilter: Type.Optional(
		Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
			description: "Only include results from this time period",
		}),
	),
});

interface BraveGroundingSource {
	url?: string;
	title?: string;
	snippets?: string[];
}

/** v0.1: environment only. v0.2 will try macOS keychain first. */
function getApiKey(): string | null {
	const key = process.env.BRAVE_API_KEY;
	return key && key.trim() !== "" ? key.trim() : null;
}

function redact(text: string, key: string | null): string {
	return key ? text.split(key).join("[REDACTED_API_KEY]") : text;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "brave_search",
		label: "Brave Search",
		description:
			"Search the web via the Brave LLM Context API. Returns ranked, pre-extracted content " +
			"chunks for the top URLs — ready to synthesize without further fetching. " +
			"Use includeContent=true when you need more than the leading snippet per source.",
		parameters: Params,

		async execute(_toolCallId, params, signal?: AbortSignal) {
			const apiKey = getApiKey();
			if (!apiKey) {
				throw new Error(
					"brave_search is not configured: the BRAVE_API_KEY environment variable is not set. " +
						"Get a key at https://brave.com/search/api/, then `export BRAVE_API_KEY=BSA_...` " +
						"in the environment that launches pi and restart pi.",
				);
			}

			const query = params.query.trim();
			if (query === "") {
				throw new Error("brave_search: query must not be empty");
			}
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
			url.searchParams.set("maximum_number_of_tokens", params.includeContent ? "16384" : "4096");
			if (params.recencyFilter) {
				url.searchParams.set("freshness", FRESHNESS[params.recencyFilter]);
			}

			try {
				const response = await fetch(url, {
					headers: {
						"X-Subscription-Token": apiKey,
						Accept: "application/json",
					},
					signal: AbortSignal.any(signal ? [AbortSignal.timeout(TIMEOUT_MS), signal] : [AbortSignal.timeout(TIMEOUT_MS)]),
				});

				if (!response.ok) {
					const body = await response.text();
					throw new Error(`Brave API error ${response.status}: ${redact(body.slice(0, 300), apiKey)}`);
				}

				const data = (await response.json()) as {
					grounding?: { generic?: BraveGroundingSource[] };
				};
				const sources = (data.grounding?.generic ?? []).filter((s) => s.url).slice(0, numResults);
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

		renderCall(args: { query?: string }, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("brave_search ")) + theme.fg("muted", `"${args.query ?? ""}"`), 0, 0);
		},

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
			const key = getApiKey();
			if (key) {
				ctx.ui.notify(
					`brave_search: configured (BRAVE_API_KEY set, ${key.slice(0, 6)}…, ${key.length} chars)`,
					"info",
				);
			} else {
				ctx.ui.notify(
					"brave_search: BRAVE_API_KEY is not set — the tool will fail until you export it and restart pi",
					"warning",
				);
			}
		},
	});
}

interface BraveDetails {
	provider: "brave-llm-context";
	query: string;
	resultCount: number;
}

function buildResult(query: string, sources: BraveGroundingSource[], includeContent: boolean) {
	if (sources.length === 0) {
		return {
			content: [{ type: "text" as const, text: `No results for "${query}"` }],
			details: { provider: "brave-llm-context", query, resultCount: 0 } as BraveDetails,
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
		const leading = snippets[0] ?? "";
		if (leading) {
			lines.push(`   ${leading}`);
		}
		if (includeContent) {
			const content = snippets.join("\n\n");
			if (content && content !== leading) {
				const bounded =
					content.length > MAX_CONTENT_CHARS
						? `${content.slice(0, MAX_CONTENT_CHARS)}\n   [content truncated at ${MAX_CONTENT_CHARS} chars]`
						: content;
				lines.push(`   ${bounded}`);
			}
		}
		lines.push("");
	}

	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: { provider: "brave-llm-context", query, resultCount: sources.length } as BraveDetails,
	};
}
