# usage-guard-collector

Get a Cloudflare usage spike alert before the invoice: a read-only Worker that watches D1 rows read, Durable Objects requests, KV, R2 and Queues, and pings Discord or Slack when today is 10x last week.

It pulls daily counts from the GraphQL Analytics API into **your own** D1 every 6 hours. One HTML page. MIT.

It never calls a Cloudflare write API. It cannot stop a Worker, delete a database or change a setting. The token you give it is Account Analytics Read and nothing else.

## Why watch Cloudflare usage instead of waiting for Budget Alerts?

Because Budget Alerts fire on the invoice total, and by then the meter has been running for days. Cloudflare's own docs call [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) "informational only. They do not pause or cap usage."

I keep a public list of this year's Cloudflare bill spikes: [Why Cloudflare bills spike: 8 D1 and Durable Objects cases from 2026](https://guushu.com/notes/cloudflare-bill-incidents-2026/). Seven are D1 rows read, one is a Durable Objects alarm loop. Amounts run from $176 to about $34,895.

The shape is the same every time. One meter ran 10,000x above normal, and the first notification was the invoice or a quota email. One thread was 1.476 trillion rows read; another was a $5 subscription that grew to about $4,115 in a month.

The GraphQL Analytics API already has every number, per day, per resource. What was missing was a thing that reads them on a schedule, remembers last week, and says "this one is 500x yesterday" somewhere I will see it. This repo is that thing, and nothing more.

## What it collects: Workers, D1, Durable Objects, KV, R2, Queues

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

## How a spike is detected: 10x the 7-day median plus a floor

`spike(today, last7)` in `src/spike.ts` is a pure function. A metric is flagged when both hold:

1. today's account-wide total is at least **10x** the median of the previous 7 days, and
2. today's total is at least an absolute floor for that metric.

The floor stops "3 requests vs 0 yesterday" from paging you. Defaults are 1% of the monthly included quota on Workers Paid (2026-09-15 pricing pages): `d1.rows_read` 250,000,000, `do.requests` 10,000, `r2.class_a` 10,000.

Override any floor with the `THRESHOLDS_JSON` var in `wrangler.jsonc`:

```jsonc
"vars": { "THRESHOLDS_JSON": "{\"d1.rows_read\": 5000000, \"kv.read\": 50000}" }
```

The first day after deploy flags nothing; there is no baseline yet. "Today" is a partial UTC day, so a spike shows up as soon as the running total crosses the bar, not at midnight.

## Deploy to your own account in seven commands

You need `wrangler` logged in to the account you want to watch (`npx wrangler login`), Node 22.5 or newer, and pnpm.

```sh
git clone https://github.com/HowardZlh/usage-guard-collector && cd usage-guard-collector
pnpm install
pnpm exec wrangler d1 create usage-guard          # paste the database_id it prints into wrangler.jsonc
pnpm exec wrangler d1 migrations apply USAGE --remote
pnpm exec wrangler secret put CF_ACCOUNT_ID       # the 32-hex id in your dashboard URL
pnpm exec wrangler secret put CF_API_TOKEN        # see "The API token" below
pnpm exec wrangler deploy
```

Optional, after deploy:

```sh
pnpm exec wrangler secret put DISCORD_WEBHOOK_URL   # or SLACK_WEBHOOK_URL, or both
```

The Cron runs at 00:00, 06:00, 12:00 and 18:00 UTC. To not wait, open the Worker in the dashboard and use the Cron trigger's "Run now". Or run it locally:

```sh
cp .dev.vars.example .dev.vars   # fill CF_ACCOUNT_ID / CF_API_TOKEN
pnpm exec wrangler d1 migrations apply USAGE --local
pnpm dev                          # then: curl "http://127.0.0.1:8787/__scheduled?cron=0+*/6+*+*+*"
```

## The API token: Account Analytics Read and nothing else

Create a token that can read analytics and nothing else. In the dashboard:

1. Profile (top right) → **API Tokens** → **Create Token** → **Create Custom Token**.
2. Name it, e.g. `usage-guard-collector`.
3. Permissions: one row, **Account** → **Account Analytics** → **Read**. No Zone row, no Workers / D1 / KV / R2 Edit rows.
4. Account Resources: **Include** → the one account you are watching.
5. Continue to summary → Create Token. Copy it once; it is not shown again.

The Worker reads it as `env.CF_API_TOKEN` and never logs it. The scheduled log line is a JSON object with counts and, if something failed, the HTTP status or GraphQL error message. No headers, no token.

## The status page, and how to put it behind Cloudflare Access

`GET /` renders the last 7 days as one table (metric x day) plus the current spike list. Plain HTML string, no framework, no external scripts, `noindex`. Anything else is 404.

It has no login. If you would rather not have your usage table on a public URL, put the Worker behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/): Zero Trust → Access → Applications → Add → Self-hosted, domain = your Worker's hostname, policy = your email. The Cron is unaffected by Access.

## Does it fit in the Workers Free plan?

Yes. One Cron trigger (Free allows 5), 4 invocations a day, 2 GraphQL requests per run, a few dozen D1 rows written per run and one read per page view.

All of that is a rounding error inside the Free tier. The collector can watch a Paid account from a Free one.

## What it does not do

No write operations of any kind (no kill switch). One account per deploy. No email. No auth on the page. No billing data.

If one of those is what you need, the "Hosted version" line below is the honest answer.

## Tests: zero network, real migration

```sh
pnpm test        # vitest, coverage gate: lines >= 85%, branches >= 80% (currently 100 / 100)
pnpm typecheck
pnpm lint        # biome
```

Every `fetch` is stubbed (`vi.stubGlobal`) across success / empty / non-2xx. D1 runs on `node:sqlite` with the real migration.

## Hosted version (waitlist)

Usage Guard is the half of this you might not want to run yourself: multiple accounts, e-mail, a stop switch. It is a waitlist page today, not a product; the form asks one question. [guard.guushu.com](https://guard.guushu.com/?utm_source=github&utm_medium=readme&utm_campaign=usage-guard-collector)

## License

MIT. See `LICENSE`.
