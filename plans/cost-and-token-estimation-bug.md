# Cost estimation and token count logic – bug analysis and plan

## Current implementation (codebase)

### Where it lives
- **`src/agents.ts`**: Hardcoded `MODEL_PRICING` (per-million-token USD) and `TOKEN_LIMITS` (context window); `estimateCost()` uses them. Token usage is parsed from Claude CLI stream events (`assistant` and `result`).
- **`src/routes/cost.ts`**: Reads `agent.usage` (tokensIn, tokensOut, estimatedCost, totalTokensSpent) and CostTracker for all-time history.
- **`src/cost-tracker.ts`**: SQLite persistence of cost records; no pricing logic.

### Current hardcoded pricing (agents.ts, ~line 886)
| Model | Input | Output | Cache read | Cache write |
|-------|-------|--------|------------|-------------|
| claude-opus-4-6 | 15 | 75 | 1.875 | 18.75 |
| claude-sonnet-4-6 | 3 | 15 | 0.3 | 3.75 |
| claude-sonnet-4-5-20250929 | 3 | 15 | 0.3 | 3.75 |
| claude-haiku-4-5-20251001 | 0.8 | 4 | 0.08 | 1 |

All token limits set to 200_000.

### How cost is computed
1. **Assistant events**: We have `usage` (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens). Cost = `AgentManager.estimateCost(model, usage)` using the table above.
2. **Result events**: We use `event.total_cost_usd` when present (from API); otherwise we still have token deltas but no cost from API in that path.

### Suspected bugs
1. **Stale pricing**: No refresh from Anthropic; prices and token limits can change. External references suggest e.g. Opus 4.6 may be $5/$25 (not $15/$75), so we may be overcounting.
2. **Missing models**: New models (e.g. 4.5, 1M context) not in the table get cost 0.
3. **Token limits**: Single 200k value for all models; context windows now vary (e.g. 1M for some).
4. **Source of truth**: We use OpenRouter (`ANTHROPIC_BASE_URL`) in this project; pricing/token semantics might differ from Anthropic direct – need to confirm.

## Research goals (sub-agents)

1. **Anthropic pricing source**: Where does Anthropic publish current per-token pricing (docs, API, JSON)? Is there a machine-readable feed?
2. **Token counting**: How does Anthropic define and report input_tokens, output_tokens, cache tokens in API responses and usage blocks?
3. **Models and context windows**: How to get current model list and context/token limits (docs vs API)?
4. **Best practices**: How do other integrations keep cost estimation up to date and handle cache/special tokens?
5. **OpenRouter**: When using OpenRouter as proxy to Claude, does pricing or usage reporting differ from Anthropic direct?

## Target outcome

- A single **optimal plan** (in this directory) that:
  - Ensures we pull latest pricing and token-limit data from an authoritative source (Anthropic or OpenRouter) where possible.
  - Keeps token counting consistent with provider (and documents any assumptions).
  - Proposes code changes (e.g. fetch on startup, periodic refresh, or documented manual update process) and where to store the data (e.g. `src/agents.ts` vs a small pricing module).

---

## Research 1: Anthropic pricing source

### Official sources (URLs)

- **Primary (detailed)**: [Pricing – Claude API Docs](https://docs.anthropic.com/en/docs/about-claude/pricing)  
  - Full model table (base input, 5m/1h cache writes, cache hits, output), batch pricing, long-context pricing, fast mode, data residency, tool pricing. All prices in USD per million tokens (MTok).
- **“Most current” (cited in docs)**: [claude.com/pricing](https://claude.com/pricing)  
  - Docs state: “For the most current pricing information, please visit claude.com/pricing.” Use for quick reference; implementation details (cache rules, tiers) are in the docs page above.
- **Related**: [Service tiers](https://docs.anthropic.com/en/api/service-tiers), [Usage and Cost API](https://docs.anthropic.com/en/api/usage-cost-api), [Data residency](https://docs.anthropic.com/docs/en/build-with-claude/data-residency).

### Machine-readable pricing

- **No public price-list API.** Anthropic does not expose the per-model, per-token rate card via a public JSON or API endpoint.
- **Models API** (`GET https://api.anthropic.com/v1/models`) returns only `id`, `created_at`, `display_name`, `type` — no pricing or context-window fields. [Models API reference](https://docs.anthropic.com/en/api/models).
- **Usage and Cost Admin API** ([usage-cost-api](https://docs.anthropic.com/en/api/usage-cost-api)) returns **your organization’s** usage and cost (token counts, cost in cents, by model/workspace/tier, etc.) in JSON. It is for *reconciliation and reporting*, not for fetching the public price table. Requires Admin API key (`sk-ant-admin...`) and an organization (not available for individual accounts).
- **Implication**: To keep pricing up to date you must either (1) parse/scrape the docs (or claude.com) page, (2) maintain an internal table updated from the docs, or (3) use a third-party source that itself derives from Anthropic’s docs.

### Region and endpoint pricing

- **Claude API (1P, direct)**: Single global pricing. No separate US vs EU rate card; all prices in USD, same regardless of where the request is sent.
- **Data residency (direct API only)**: For Opus 4.6 and newer, requesting US-only inference via `inference_geo: "us"` applies a **1.1× multiplier** to all token categories (input, output, cache writes, cache reads). Default (global) has no multiplier. [Pricing – Data residency](https://docs.anthropic.com/en/docs/about-claude/pricing#data-residency-pricing), [Data residency](https://docs.anthropic.com/docs/en/build-with-claude/data-residency).
- **Third-party (Bedrock, Vertex, Foundry)**: Have their own pricing pages. For Bedrock/Vertex, “regional” endpoints (data in a specific region) can carry a **10% premium** over “global” for some models (e.g. Sonnet 4.5, Haiku 4.5 and beyond). Not applicable to our backend if we only use Anthropic’s API or OpenRouter.

### Cache read/write pricing rules (documented)

From [Pricing – Model pricing](https://docs.anthropic.com/en/docs/about-claude/pricing#model-pricing):

- **Cache read** (“Cache Hits & Refreshes”): **0.1×** (10%) of base input price per MTok.
- **5-minute cache write**: **1.25×** base input price per MTok.
- **1-hour cache write**: **2×** base input price per MTok.

So “10% of input price for reads” is correct; writes are 125% and 200% of base input respectively. Our current hardcoded table should use these multipliers from the base input column for cache_read and cache_write (and optionally distinguish 5m vs 1h if we ever support that).

---

## Research 3: Models and context windows

### Where Anthropic documents model IDs and context window sizes

- **Primary source (canonical list):** [Models overview](https://docs.anthropic.com/en/docs/about-claude/models/overview) — “Latest models comparison” and “The following models are still available” tables.
- **Context window behavior and 1M beta:** [Context windows](https://docs.anthropic.com/en/docs/build-with-claude/context-windows) — explains 200K default, 1M beta, and links to the model comparison table for sizes.
- **API reference (models):** [Models](https://docs.anthropic.com/en/api/models) — describes `GET /v1/models` and `GET /v1/models/{model_id}`; no context-window or token-limit fields in responses.

### API vs docs

- **API:** `GET https://api.anthropic.com/v1/models` (and `GET /v1/models/{model_id}`) return **model list only**. Response shape: `data[]` of `ModelInfo` with `id`, `created_at`, `display_name`, `type` (`"model"`). **No `context_window`, `max_tokens`, or token-limit fields** in the API.
- **Conclusion:** Model IDs (and aliases via retrieve) are available via API; **context window sizes and token limits are docs-only** — no machine-readable API for limits.

### 1M-token and extended-context models

- **1M token context:** Same model IDs as standard; not separate IDs. Enabled with beta header `anthropic-beta: context-1m-2025-08-07`. Long-context pricing applies for requests exceeding 200K tokens.
- **Models with 1M (beta):** Claude Opus 4.6 (`claude-opus-4-6`), Claude Sonnet 4.6 (`claude-sonnet-4-6`), Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`), Claude Sonnet 4 (`claude-sonnet-4-20250514`). Per docs, 1M is available only for usage tier 4 and custom rate limits.
- **Standard 200K only (no 1M in docs):** e.g. Claude Haiku 4.5 (`claude-haiku-4-5-20251001`), Claude Opus 4.5 (`claude-opus-4-5-20251101`), Claude Opus 4.1 (`claude-opus-4-1-20250805`), Claude Opus 4 (`claude-opus-4-20250514`).
- **Max output:** Varies by model (e.g. 128K for Opus 4.6, 64K for Sonnet 4.6 / Haiku 4.5, 32K for some older). Documented in the same Models overview tables.

### Docs page structure for manual update or scrape

- **URL:** `https://docs.anthropic.com/en/docs/about-claude/models/overview`
- **Structure:**
  - Two main markdown tables:
    1. **“Latest models comparison”** — columns: Feature | Claude Opus 4.6 | Claude Sonnet 4.6 | Claude Haiku 4.5. Rows include “Claude API ID”, “Context window”, “Max output”, “Pricing”, etc.
    2. **“The following models are still available”** — same row semantics for older models (Sonnet 4.5, Opus 4.5, Opus 4.1, Sonnet 4, Opus 4, Haiku 3 deprecated).
  - **Context window cell values:** Either “200K tokens” or “200K tokens / 1M tokens (beta)” (with footnote pointing to 1M beta header and long-context pricing).
  - **Model IDs:** In the “Claude API ID” row; aliases in “Claude API alias” row.
- **Stable anchors for scraping:** Table headers “Latest models comparison” and “The following models are still available”; row labels “Claude API ID”, “Context window”, “Max output”. Footnotes (e.g. “1 - … 1M token context window …”) describe beta header and pricing.
- **Token counting API:** [Token counting](https://docs.anthropic.com/en/docs/build-with-claude/token-counting) / [Count tokens](https://docs.anthropic.com/en/api/messages-count-tokens) — counts tokens in a message; **does not** return per-model context or output limits.

### Summary for implementation

- Use **`GET /v1/models`** to keep **model IDs** (and aliases) up to date programmatically.
- **Context window and max output** must come from **docs** (manual update or scrape of the Models overview page). No API field exists for these.
- For 1M context: same IDs as 200K; distinguish by whether the client sends the `context-1m-2025-08-07` beta header; backend cost/limit logic may treat 1M as a separate “mode” (e.g. 1_000_000 vs 200_000) when the header is used.

---

## Research 2: Token counting and usage object

Findings from Anthropic’s official API docs (streaming, usage/cost API, prompt caching, Admin API reference). Doc links at the end.

### 1. How usage is reported – field names and semantics

- **Field names (Messages API / streaming):**
  - `input_tokens` – uncached input tokens for this request.
  - `output_tokens` – output tokens generated.
  - `cache_creation_input_tokens` – input tokens used to create cache entries (writes).
  - `cache_read_input_tokens` – input tokens read from cache (cache hits).
- **Where they appear:** In streaming, `usage` appears in:
  - **`message_start`** – initial snapshot (e.g. `input_tokens`, `output_tokens`; when caching is used, also `cache_creation_input_tokens`, `cache_read_input_tokens`).
  - **`message_delta`** – one or more events with **cumulative** token counts for that message (not per-event deltas). The **last** `message_delta` before `message_stop` carries the final cumulative usage for the request (and may include all four token fields plus `server_tool_use` when applicable).
- **Per-request vs cumulative:** Usage is **per request** (one message/response). Within that stream, values in `message_delta.usage` are **cumulative** for that single response. So the correct total for the call is the usage from the final `message_delta` (or the merged view: input/cache from `message_start`, output/cache from last `message_delta`).
- **Non-streaming:** For `POST /v1/messages` with `stream: false`, the response body includes a `usage` object with the same token fields (per-request totals).
- **Admin Usage API** uses slightly different names: `uncached_input_tokens`, `cache_read_input_tokens`, `cache_creation` (with `ephemeral_1h_input_tokens`, `ephemeral_5m_input_tokens`). So “input” in the Messages API = uncached input; cache creation is split by TTL in the Admin API.

**Doc refs:** [Streaming Messages](https://docs.anthropic.com/en/api/messages-streaming) (event types, example with `usage` in `message_start` and `message_delta`), [Get Messages Usage Report](https://docs.anthropic.com/en/api/admin-api/usage-cost/get-messages-usage-report) (Admin schema).

### 2. Result / message_complete and total_cost_usd

- **Messages API (and streaming)** do **not** return `total_cost_usd` (or any cost field) in the response or in any SSE event. Only token counts are returned; cost must be computed client-side from usage + pricing, or obtained later from the Admin API.
- **`message_stop`** is the final event and has no payload (no `usage`); the final usage is in the last **`message_delta`**.
- **`total_cost_usd`** appears in the **Claude Agent SDK** (multi-step / “result” object), which aggregates usage and cost across steps. It is **not** part of the raw Messages API or streaming contract. So any backend that parses “result” or “message_complete” events and expects `total_cost_usd` is either (a) using the Agent SDK and reading its result object, or (b) relying on an intermediary (e.g. Claude CLI) that may add a cost field – in which case that is not guaranteed by Anthropic’s API docs.
- **Cost in USD** for organization-level reporting is provided by the **Usage & Cost Admin API** (`/v1/organizations/cost_report`), not per-message. So for per-request cost, the backend should use token counts + pricing table (or accept that only token-based estimates are available from the API).

**Doc refs:** [Streaming Messages](https://docs.anthropic.com/en/api/messages-streaming), [Usage and Cost API](https://docs.anthropic.com/en/api/usage-cost-api), [Tracking Costs and Usage (Claude Code / Agent SDK)](https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-cost-tracking).

### 3. Cache tokens and billing

- **Separate buckets:** Cache read and cache creation are reported and billed separately from uncached input. Billing uses different rates (cache read much cheaper than cache creation; cache creation more than base input for longer TTL).
- **Pricing (from Prompt Caching doc):** “Base Input” = uncached; “5m Cache Writes” / “1h Cache Writes” = cache creation by TTL; “Cache Hits & Refreshes” = cache read. Multipliers: cache read ≈ 0.1× base input; 5m write ≈ 1.25× base; 1h write ≈ 2× base. Our `estimateCost()` use of `cache_creation_input_tokens` and `cache_read_input_tokens` aligns with this; the Admin API’s `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` would allow finer billing if we ever consume that API.
- **Token counting with caching:** Cached prompts still produce the same four token fields; cache read tokens are counted in `cache_read_input_tokens`, so they are not double-counted in `input_tokens`. Billing is applied to each bucket according to the published pricing (input vs cache read vs cache creation).

**Doc refs:** [Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) (pricing table and multipliers), [Usage and Cost API](https://docs.anthropic.com/en/api/usage-cost-api) (token tracking: “uncached input, cached input, cache creation, and output tokens”), [Get Messages Usage Report](https://docs.anthropic.com/en/api/admin-api/usage-cost/get-messages-usage-report).

### 4. Recent (2025–2026) usage and token semantics

- **Usage object shape** in Messages API / streaming is unchanged in the docs: same four token fields; no new top-level usage fields for 2025–2026 in the streaming or Messages create docs.
- **Admin / Usage & Cost API** has 2025–2026 additions:
  - **`inference_geo`** – filtering/grouping by inference geography (`global`, `us`, `not_available`). Models before Feb 2026 (e.g. pre–Opus 4.6) report `not_available`.
  - **`speed`** (fast mode) – research preview; requires beta header `fast-mode-2026-02-01`; values `standard` / `fast`.
  - **Context window** – usage can be filtered/grouped by `context_window` (e.g. `0-200k`, `200k-1M`).
- **Streaming:** No documented change to the semantics of `usage` in `message_start` or `message_delta` (still cumulative per message). Error recovery behavior differs for 4.5 vs 4.6 (resume vs “continue from where you left off”); unrelated to usage object.

**Doc refs:** [Usage and Cost API](https://docs.anthropic.com/en/api/usage-cost-api) (data residency, fast mode, time buckets), [Get Messages Usage Report](https://docs.anthropic.com/en/api/admin-api/usage-cost/get-messages-usage-report) (parameters and response schema).

### Summary for this backend

- Rely on **`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`** from `message_start` and the **last `message_delta`** (cumulative for that request). Do not treat `message_delta` as deltas; use final cumulative values.
- **Do not rely on `total_cost_usd`** from the Messages API or streaming; it is not in the API contract. If “result” or “message_complete” events include it (e.g. from Claude CLI), treat it as optional; keep client-side estimation from token counts + pricing as the documented source of truth.
- Cache token handling (separate counts and pricing for read vs creation) matches Anthropic’s model; keep applying pricing to all four token types as in current `estimateCost()`.

---

## Research 5: OpenRouter vs Anthropic

- **Pricing source and markup**: OpenRouter documents model pricing at [openrouter.ai/pricing](https://openrouter.ai/pricing) and in the model catalog ([openrouter.ai/models](https://openrouter.ai/models)). They state they **do not mark up** provider pricing: “Pricing shown in the model catalog is what you pay which is exactly what you will see on provider’s websites.” So for Claude, OpenRouter’s listed prices should match Anthropic’s (no extra markup). Prices are still subject to provider changes; OpenRouter passes through new rates and charges accordingly.

- **Where pricing is documented**: Per-model rates (per million tokens) are on the OpenRouter pricing/model pages. **Programmatic access**: `GET https://openrouter.ai/api/v1/models` returns a list of models; each model has a `pricing` object with `prompt`, `completion`, `input_cache_read`, `input_cache_write`, etc. (see [Get models](https://openrouter.ai/docs/api-reference/models/get-models)). This can be used for cost estimation and to avoid hardcoding rates. Response is cached at the edge.

- **Usage response field names – two APIs**:  
  - **Anthropic Messages API** (e.g. when Claude CLI uses `ANTHROPIC_BASE_URL=https://openrouter.ai/api`): OpenRouter implements the Anthropic Messages API (`/api/v1/messages`). Documentation indicates the response follows Anthropic’s format and includes usage with **`input_tokens`** (and by implication the same usage shape as Anthropic). So when using the Anthropic-compatible path, field names **match Anthropic** (`input_tokens`, `output_tokens`, and cache fields if supported).  
  - **OpenAI-compatible API**: For the OpenAI-style completion API, OpenRouter uses **different names**: `prompt_tokens` (not `input_tokens`), `completion_tokens` (not `output_tokens`), `total_tokens`; cache is under `prompt_tokens_details.cached_tokens` and `prompt_tokens_details.cache_write_tokens` (not top-level `cache_read_input_tokens` / `cache_creation_input_tokens`). Our code today parses **Anthropic-style** fields from Claude CLI stream events; if the CLI talks to OpenRouter’s Anthropic endpoint, those names should align.

- **Cost in response**: For the **OpenAI-compatible** API, OpenRouter’s [Usage Accounting](https://openrouter.ai/docs/guides/guides/usage-accounting) doc states every response includes a `usage` object with **`cost`** (total amount charged to your account, in **credits**, not necessarily USD). So they do return a total cost in the response, but as **`usage.cost`** in credits. For the **Anthropic Messages API** path, OpenRouter’s docs do not clearly state whether they return `total_cost_usd` or an equivalent; our code uses `event.total_cost_usd` from result events when present. **Recommendation**: Verify in practice whether OpenRouter’s Anthropic endpoint includes a cost field (e.g. `total_cost_usd` or a different name) in stream/response; if not, we must rely on token counts + pricing for estimation.

- **Cache token semantics**: OpenRouter supports prompt caching for Claude (with `cache_control`). Cache usage appears as `prompt_tokens_details.cached_tokens` and `prompt_tokens_details.cache_write_tokens` in the OpenAI-style response. On the Anthropic path, if OpenRouter mirrors Anthropic’s usage block, we’d expect `cache_read_input_tokens` and `cache_creation_input_tokens` (or equivalent). Cache pricing: OpenRouter docs state cache reads at 0.1× input price and cache writes at 1.25× input price for Claude.

- **Getting correct rates for cost estimation**: (1) **OpenRouter Models API**: Call `GET /api/v1/models` (with `Authorization: Bearer <key>`); use each model’s `pricing` (prompt, completion, input_cache_read, input_cache_write) for per-token cost. (2) **Dashboard**: Activity and export show spend; model catalog shows per-model pricing. (3) **Docs**: [openrouter.ai/pricing](https://openrouter.ai/pricing) and model pages. Prefer the Models API for a single, programmatic source of truth that stays in sync with OpenRouter’s catalog.

---

## Research 4: Best practices for cost estimation

### Findings

- **Anthropic does not expose a public pricing API.** The [Usage & Cost Admin API](https://docs.anthropic.com/en/api/usage-cost-api) returns *your* usage and cost (reconciliation), not the public rate card. Official pricing is documented as tables at [docs.anthropic.com](https://docs.anthropic.com/en/docs/about-claude/pricing) and [claude.com/pricing](https://claude.com/pricing); there is no machine-readable JSON feed from Anthropic.
- **OpenRouter exposes pricing in the models list.** `GET https://openrouter.ai/api/v1/models` returns a `data` array; each model has a `pricing` object with `prompt`, `completion`, `request`, `image`, `input_cache_read`, `input_cache_write`, etc. (USD per token). No auth required for listing. Since this project uses OpenRouter (`ANTHROPIC_BASE_URL`), fetching from this endpoint is the natural source of truth for *OpenRouter* pricing.
- **Strategies observed elsewhere:**
  - **Fetch on startup / periodic refresh:** token-costs and llm_api_cost_calc fetch pricing from remote (e.g. GitHub, LiteLLM repo) with local JSON fallback; token-costs updates daily. OpenRouter’s `/api/v1/models` can be fetched on server startup and optionally refreshed on an interval or TTL.
  - **Static file, update on release:** LiteLLM uses `model_prices_and_context_window.json` on GitHub; apps ship a static file and update it with releases. LangSmith uses built-in static pricing for major providers and allows custom cost data for others.
  - **Env or admin overrides:** Common pattern for custom rates or air-gapped deployments; no “admin API to update pricing” standard found, but env-based overrides are typical.
- **Best-practice guidance (general):** Monitor spend (e.g. Anthropic Usage API for direct customers), use caching to reduce tokens, choose the right model tier; output tokens are 5–10× input cost. For *estimation* in app code, the main decision is where to get the rate card: provider API when available, else static file with a documented update process.

### Recommendation

- **When using OpenRouter (current default):** **Fetch pricing from OpenRouter on startup.** Call `GET https://openrouter.ai/api/v1/models` at server startup, parse `data[].pricing` (e.g. `prompt`/`completion` → input/output per token; scale to per-million for existing `estimateCost`). Optionally refresh on a TTL (e.g. hourly) or on first request after expiry. Map model IDs from Claude CLI/streams to OpenRouter model `id` (e.g. `anthropic/claude-...`) and handle missing models by falling back to 0 or a default rate.
- **Fallback / direct Anthropic:** **Ship a static JSON file** (e.g. `src/model-pricing.json` or under `config/`) with base input/output (and cache read/write if needed) per model, updated on release or via a documented manual process (e.g. “update from Anthropic pricing docs and run tests”). Use env vars (e.g. `MODEL_PRICING_JSON_PATH` or overrides) only if you need to point to a different file or override rates.
- **Avoid:** Scraping Anthropic’s HTML pricing page (fragile, unofficial). Relying on a “pricing API” from Anthropic for the rate card (none exists for public rates).
- **Optional:** Add an admin or internal API to *reload* pricing from the chosen source (OpenRouter or static file) without restart, for operational convenience; keep the single source of truth as “OpenRouter API” or “static file,” not a separate database of ad-hoc overrides unless required.

---

## Optimal plan (implementation)

### Goals
1. **Always pull latest pricing** from an authoritative source where possible (OpenRouter, since we use it).
2. **Keep token counting correct** – current parsing of `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` from assistant/result events is correct; do not rely on API-provided `total_cost_usd` as primary (treat as optional if present).
3. **Fix stale/missing data** – avoid hardcoded tables that drift from reality; support new models and updated rates without code changes.

### Recommended approach (OpenRouter as primary)

| Step | Action |
|------|--------|
| 1 | **Add a pricing module** (e.g. `src/pricing.ts` or `src/model-pricing.ts`) that: (a) fetches `GET https://openrouter.ai/api/v1/models` on server startup; (b) builds a map from model ID (e.g. `anthropic/claude-sonnet-4` or the exact ID we use in `agent.model`) to `{ inputPerM, outputPerM, cacheReadPerM, cacheWritePerM }` using OpenRouter’s `pricing.prompt`, `pricing.completion`, `pricing.input_cache_read`, `pricing.input_cache_write` (convert from per-token to per-million if needed). |
| 2 | **Optional TTL refresh**: Refresh the pricing map periodically (e.g. every 1–6 hours) or on first request after expiry, to pick up OpenRouter catalog updates without restart. |
| 3 | **Model ID mapping**: Ensure our agent `model` values (e.g. `claude-sonnet-4-6`) map to OpenRouter’s model IDs (e.g. `anthropic/claude-sonnet-4` or whatever OpenRouter returns). Document or implement a small mapping layer if OpenRouter uses different names. |
| 4 | **Fallback when model missing**: If a model is not in the OpenRouter response, fall back to (a) a small bundled static JSON (e.g. `src/model-pricing-fallback.json`) with last-known Anthropic rates, or (b) return 0 cost and log a warning. Prefer (a) so new models still get estimated cost after a one-time fallback update. |
| 5 | **Token limits**: Keep token limits in code or a small static file; OpenRouter/Anthropic do not expose context window in the models API. Update from [Models overview](https://docs.anthropic.com/en/docs/about-claude/models/overview) on release or via a documented process. Optionally add a fallback map in the same JSON as pricing (e.g. `context_window_tokens` per model). |
| 6 | **Refactor `agents.ts`**: Replace `AgentManager.MODEL_PRICING` and `AgentManager.TOKEN_LIMITS` with calls to the new pricing module (e.g. `getPricing(model)`, `getTokenLimit(model)`). Keep `estimateCost(model, usage)` but have it use the dynamic pricing map; if pricing is unavailable (e.g. fetch failed at startup), use fallback static data or 0 and log. |
| 7 | **Do not rely on `total_cost_usd`**: In `handleEvent` for `result` events, keep using `event.total_cost_usd` when present (e.g. from Claude CLI), but treat it as optional. Primary cost should always be computed from token counts + pricing so behavior is consistent and auditable. |
| 8 | **Tests**: Add unit tests for the pricing module (fetch mock, mapping, fallback, and `estimateCost` with dynamic pricing). Keep existing cost-tracker and cost-route tests; update any that assert exact hardcoded rates to use fixtures or mock pricing. |

### If not using OpenRouter (direct Anthropic only)

- **No Anthropic pricing API**: Use a **static JSON file** in repo (e.g. `config/model-pricing.json`) with per-model input/output/cache-read/cache-write per million tokens, updated manually from [docs.anthropic.com pricing](https://docs.anthropic.com/en/docs/about-claude/pricing) on release or when models/prices change.
- **Token counting**: Unchanged; same four usage fields and client-side cost estimation.

### Summary of bug fixes
- **Stale pricing**: Fixed by fetching from OpenRouter on startup (+ optional refresh) or by documented updates to static JSON.
- **Missing models**: New models in OpenRouter response get pricing automatically; otherwise fallback file or 0 with warning.
- **Token limits**: Single 200k default replaced by a configurable map (code or JSON), updated from docs when needed.
- **Source of truth**: OpenRouter Models API (or static file when not using OpenRouter) is the single source; no more hardcoded tables in `agents.ts`.
