# usage-guard-collector

A read-only Cloudflare Worker that pulls your account's daily Workers / D1 / Durable Objects / KV / R2 / Queues counts from the GraphQL Analytics API into **your own** D1 database every 6 hours, and flags a metric when today is at least 10× its 7-day median. Optional Discord or Slack webhook. One HTML page. MIT.

It never calls a Cloudflare write API. It cannot stop a Worker, delete a database, or change a setting. The token you give it is analytics-read only.

## Why

I keep a list of this year's public "why is my Cloudflare bill this big" threads: [guushu.com/notes/cloudflare-bill-incidents-2026](https://guushu.com/notes/cloudflare-bill-incidents-2026/). Eight so far. The pattern is the same each time: one meter (D1 rows read, a DO alarm loop, R2 Class A ops) ran 100× to 10,000× above normal for days, and nobody looked at the analytics tab until the invoice arrived. One of them was 1.476 trillion rows read on a $5 plan.

Cloudflare's own [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) are, in their docs' words, "informational only. They do not pause or cap usage." — one email on the invoice total. The GraphQL Analytics API already has every number you need, per day, per resource. What was missing for me was a thing that reads those numbers on a schedule, remembers last week, and says "this one is 500× yesterday" somewhere I will see it. This repo is that thing, and nothing more.

## What it collects

One row per UTC day, product, metric and resource. Dataset and field names were checked against the live schema by introspection on 2026-09-15 (`src/graphql.ts`).

| Product | GraphQL dataset | Metrics stored | Resource dimension |
|---|---|---|---|
| Workers | `workersInvocationsAdaptive` | `requests`, `errors`, `cpu_ms` | `scriptName` |
| D1 | `d1AnalyticsAdaptiveGroups` | `rows_read`, `rows_written`, `read_queries`, `write_queries` | `databaseId` |
| Durable Objects | `durableObjectsInvocationsAdaptiveGroups` | `requests` | `scriptName` |
| KV | `kvOperationsAdaptiveGroups` | `read`, `write`, `delete`, `list` | `namespaceId` |
| R2 | `r2OperationsAdaptiveGroups` | `class_a`, `class_b` (per the R2 pricing page lists) | `bucketName` |
| Queues | `queueMessageOperationsAdaptiveGroups` | `operations` (billable) | `queueId` |

These are analytics counts, not the invoice. Cloudflare's docs say the analytics datasets include traffic that billing excludes, so expect the numbers to sit a little above what you are charged for.

## Spike rule

`spike(today, last7)` in `src/spike.ts` is a pure function. A metric is flagged when both hold:

1. today's account-wide total ≥ **10 ×** the median of the previous 7 days, and
2. today's total ≥ an absolute floor for that metric.

The floor stops "3 requests vs. 0 yesterday" from paging you. Defaults are 1% of the monthly included quota on Workers Paid (2026-09-15 pricing pages), e.g. `d1.rows_read` 250,000,000, `do.requests` 10,000, `r2.class_a` 10,000. Override any of them with the `THRESHOLDS_JSON` var in `wrangler.jsonc`:

```jsonc
"vars": { "THRESHOLDS_JSON": "{\"d1.rows_read\": 5000000, \"kv.read\": 50000}" }
```

The first day after deploy flags nothing: there is no baseline yet. "Today" is a partial UTC day, so a spike shows up as soon as the running total crosses the bar, not at midnight.

## Deploy

You need `wrangler` logged in to the account you want to watch (`npx wrangler login`), Node ≥ 22.5 and pnpm.

```sh
git clone https://github.com/HowardZlh/usage-guard-collector && cd usage-guard-collector
pnpm install
pnpm exec wrangler d1 create usage-guard          # paste the database_id it prints into wrangler.jsonc
pnpm exec wrangler d1 migrations apply USAGE --remote
pnpm exec wrangler secret put CF_ACCOUNT_ID       # the 32-hex id in your dashboard URL
pnpm exec wrangler secret put CF_API_TOKEN        # see "Token" below
pnpm exec wrangler deploy
```

Optional, after deploy:

```sh
pnpm exec wrangler secret put DISCORD_WEBHOOK_URL   # or SLACK_WEBHOOK_URL, or both
```

The Cron runs at 00:00, 06:00, 12:00 and 18:00 UTC. To not wait, open the Worker in the dashboard and use the Cron trigger's "Run now", or locally:

```sh
cp .dev.vars.example .dev.vars   # fill CF_ACCOUNT_ID / CF_API_TOKEN
pnpm exec wrangler d1 migrations apply USAGE --local
pnpm dev                          # then: curl "http://127.0.0.1:8787/__scheduled?cron=0+*/6+*+*+*"
```

## Token

Create a token that can read analytics and nothing else. In the dashboard:

1. Profile (top right) → **API Tokens** → **Create Token** → **Create Custom Token**.
2. Name it, e.g. `usage-guard-collector`.
3. Permissions: one row, **Account** → **Account Analytics** → **Read**. Do not add any Zone row, and no Workers / D1 / KV / R2 Edit rows.
4. Account Resources: **Include** → the one account you are watching.
5. Continue to summary → Create Token. Copy it once; it is not shown again.

The Worker reads it as `env.CF_API_TOKEN` and never logs it. The scheduled log line is a JSON object with counts and, if something failed, the HTTP status or GraphQL error message — no headers, no token.

## The page

`GET /` renders the last 7 days as one table (metric × day) plus the current spike list. Plain HTML string, no framework, no external scripts, `noindex`. Anything else is 404.

It has no login. If you would rather not have your usage table on a public URL, put the Worker behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/): Zero Trust → Access → Applications → Add → Self-hosted, domain = your Worker's hostname, policy = your email. The Cron is unaffected by Access.

## Free plan fit

One Cron trigger (Free plan allows 5), 4 invocations a day, 2 GraphQL requests per run, a few dozen D1 rows written per run and one read per page view. All of that is a rounding error inside the Workers Free tier; the collector can watch a Paid account from a Free one.

## Not in scope

No write operations of any kind (no kill switch), a single account per deploy, no email, no auth on the page, no billing data. If one of those is what you need, the "Hosted" line below is the honest answer.

## Tests

```sh
pnpm test        # vitest, coverage gate: lines ≥ 85%, branches ≥ 80% (currently 100 / 100)
pnpm typecheck
pnpm lint        # biome
```

Every `fetch` is stubbed (`vi.stubGlobal`) across success / empty / non-2xx. D1 runs on `node:sqlite` with the real migration. Zero network in tests.

## Hosted

The hosted version, Usage Guard, is the half of this that you might not want to run yourself: multiple accounts, e-mail, a stop switch. It is a waitlist page today, not a product; the form asks one question. [guard.guushu.com](https://guard.guushu.com/?utm_source=github&utm_medium=readme&utm_campaign=usage-guard-collector)

## License

MIT. See `LICENSE`.
