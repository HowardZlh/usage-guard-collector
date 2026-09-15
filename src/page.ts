/** GET / — plain HTML string. No framework, no external scripts, no external CSS. */
import type { MetricKey, Spike } from "./spike";
import { formatRatio } from "./spike";

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function fmtNum(n: number | undefined): string {
  if (n === undefined) return "–";
  return Number.isInteger(n)
    ? n.toLocaleString("en-US")
    : n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

export interface PageModel {
  /** Ascending, oldest first; the last one is today. */
  dates: string[];
  table: Map<MetricKey, Map<string, number>>;
  spikes: Spike[];
  /** ISO timestamp of the newest collected_at, or null when the table is empty. */
  lastCollected: string | null;
}

const CSS = `body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:64rem;margin:2rem auto;padding:0 1rem;color:#222}
table{border-collapse:collapse;width:100%}th,td{padding:.3rem .5rem;border-bottom:1px solid #ddd;text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{font-weight:600}.spike{background:#fff3e0}.muted{color:#777}code{font-size:.9em}`;

export function renderPage(m: PageModel): string {
  const spikeKeys = new Set(m.spikes.map((s) => s.metric));
  const head = m.dates.map((d) => `<th>${escapeHtml(d.slice(5))}</th>`).join("");
  const metrics = [...m.table.keys()].sort();
  const body =
    metrics.length === 0
      ? `<tr><td colspan="${m.dates.length + 1}" class="muted">No rows yet. The Cron runs every 6 hours; trigger one with <code>curl -X POST http://127.0.0.1:8787/__scheduled</code> under <code>wrangler dev --test-scheduled</code>.</td></tr>`
      : metrics
          .map((k) => {
            const byDate = m.table.get(k) as Map<string, number>;
            const cells = m.dates.map((d) => `<td>${fmtNum(byDate.get(d))}</td>`).join("");
            return `<tr${spikeKeys.has(k) ? ' class="spike"' : ""}><td><code>${escapeHtml(k)}</code></td>${cells}</tr>`;
          })
          .join("");

  const spikes =
    m.spikes.length === 0
      ? `<p class="muted">No spikes today (today ≥ 10× the 7-day median and above the per-metric floor).</p>`
      : `<ul>${m.spikes
          .map(
            (s) =>
              `<li><code>${escapeHtml(s.metric)}</code>: ${fmtNum(s.today)} today vs. median ${fmtNum(s.baseline)} (${escapeHtml(formatRatio(s.ratio))})</li>`,
          )
          .join("")}</ul>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>usage-guard-collector</title><style>${CSS}</style></head><body>
<h1>Cloudflare usage, last ${m.dates.length} days</h1>
<p class="muted">Account-wide daily totals from the GraphQL Analytics API (UTC days; today is partial).
${m.lastCollected ? `Last collected ${escapeHtml(m.lastCollected)}.` : "Not collected yet."}
These are analytics counts, not the invoice.</p>
<h2>Spikes</h2>${spikes}
<h2>Daily totals</h2>
<table><thead><tr><th>metric</th>${head}</tr></thead><tbody>${body}</tbody></table>
<p class="muted">Read-only. Source: <a href="https://github.com/HowardZlh/usage-guard-collector">github.com/HowardZlh/usage-guard-collector</a>.</p>
</body></html>`;
}
