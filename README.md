# pi-brave-search

A deliberately minimal web search tool for [Pi](https://github.com/earendil-works/pi) coding agent,
backed by the [Brave LLM Context API](https://brave.com/search/api/).

One tool, one key, one file (~200 lines). No fallback chains, no caching, no curation —
failures surface as plain errors so the wires stay visible.

## The tool

`brave_search` — search the web and get ranked, **pre-extracted content chunks** per URL
(from the `/res/v1/llm/context` endpoint, not plain `/web/search`). Results are ready to
synthesize without further fetching.

Parameters:

| Parameter | Type | Notes |
|---|---|---|
| `query` | string | required |
| `numResults` | number | 1–20, default 5 |
| `includeContent` | boolean | request the full extracted content per source (16k token budget instead of 4k) |
| `recencyFilter` | `day` \| `week` \| `month` \| `year` | restrict to a time period |

Also: `/brave-status` command to check whether a key is configured.

## Setup

```sh
export BRAVE_API_KEY=BSA_...   # get a key at https://brave.com/search/api/
```

The key is read from the environment **at call time**.

## Install into Pi

```sh
# from this directory
pi install "$(pwd)"
```

Or from a clone:

```sh
pi install git:github.com/<you>/pi-brave-search
```

## Development

```sh
npm install
npm run typecheck
pi --extension ./extensions/index.ts   # load without installing
```

## Design notes

Inherited from hard-won lessons (see the `pi-web-access` fork this started as):

1. **Credential redaction** — the key is stripped from every error message; Brave echoes
   `X-Subscription-Token` in some error bodies.
2. **Timeout + abort** — hard 30s timeout, combined with the caller's abort signal.
3. **Bounded output** — results are capped at 20; inline content is capped at 8k chars
   per source so one long page can't blow the context window.

## Roadmap

- [ ] key from macOS keychain (fall back to env) — `security find-generic-password`
- [ ] domain allow/block filters
- [ ] store full results out-of-context, retrievable by id (like `pi-web-access`'s `responseId`)
- [ ] upstream the `llm/context` support into `pi-web-access` (this project began as that fork)

## License

MIT
