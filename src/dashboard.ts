// Status page served at GET /. Everything is computed from KV per request, and
// the page reloads itself, so a tab left open stays current. It only shows what
// is public anyway (tweets, Bluesky posts, run results); the controls stay
// behind RUN_TOKEN.
import { config } from './config.ts'
import * as state from './state.ts'

type Health = 'healthy' | 'attention' | 'failing' | 'stale' | 'paused'

// A day of 5-minute ticks, for the run strip.
const STRIP_RUNS = 288

/** Minutes between cron ticks, for spotting a cron that stopped firing. */
function cronIntervalMinutes(schedule: string): number {
    const every = schedule.match(/^\*\/(\d+) \* \* \* \*$/)
    if (every) return parseInt(every[1])
    if (/^\* \* \* \* \*$/.test(schedule)) return 1
    return 60
}

export async function getStatus() {
    const [paused, lastRun, runs, published, pending, lock, backfill] = await Promise.all([
        state.isPaused(),
        state.getLastRun() as Promise<state.Run | null>,
        state.recentRuns(STRIP_RUNS),
        state.publishedPosts(),
        state.pendingAttempts(),
        state.getLock(),
        state.getBackfill(),
    ])

    const now = Date.now()
    const interval = cronIntervalMinutes(config.cronSchedule)
    const sinceLastRun = lastRun ? now - new Date(lastRun.at).getTime() : null
    const lastSuccess = runs.find(r => r.ok) ?? (lastRun?.ok ? lastRun : null)
    const consecutiveFailures = runs.findIndex(r => r.ok) === -1 ? runs.length : runs.findIndex(r => r.ok)
    const day = runs.filter(r => now - new Date(r.at).getTime() < 86400000)
    const stuck = pending.filter(p => p.attempts > config.maxAttemptsWithVideo)

    let health: Health
    let summary: string
    if (paused) {
        health = 'paused'
        summary = 'Paused: cron ticks skip until resumed.'
    } else if (lastRun && !lastRun.ok) {
        health = 'failing'
        summary = /session cookies/.test(lastRun.error ?? '')
            ? 'X rejected the session cookies. Refresh TWITTER_CT0 and TWITTER_AUTH_TOKEN.'
            : `The last ${consecutiveFailures > 1 ? `${consecutiveFailures} runs` : 'run'} failed.`
    } else if (!lastRun) {
        health = 'attention'
        summary = 'No runs recorded yet.'
    } else if (sinceLastRun! > (interval * 3 + 5) * 60000) {
        health = 'stale'
        summary = `No run for ${ago(lastRun.at, now)}; cron should fire every ${interval} min.`
    } else if (stuck.length) {
        health = 'attention'
        summary = `${stuck.length} tweet${stuck.length > 1 ? 's keep' : ' keeps'} failing to mirror.`
    } else {
        health = 'healthy'
        summary = lastRun.remaining ? `Catching up: ${lastRun.remaining} tweets to go.` : 'Mirroring normally.'
    }

    const recent = published
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
        .slice(0, 10)
        .map(p => ({
            createdAt: p.createdAt,
            text: p.description,
            media: p.media?.length ?? 0,
            quote: !!p.quotedGuid,
            tweet: `https://x.com/${config.twitterUser}/status/${p.guid}`,
            bluesky: blueskyUrl(p.uri!),
        }))

    return {
        health,
        summary,
        generatedAt: new Date(now).toISOString(),
        build: Deno.env.get('DENO_DEPLOYMENT_ID') ?? null,
        user: config.twitterUser,
        target: config.bskyUsername,
        schedule: config.cronSchedule,
        intervalMinutes: interval,
        paused,
        running: !!lock,
        backfill,
        lastRun,
        lastSuccess,
        consecutiveFailures,
        last24h: {
            runs: day.length,
            failed: day.filter(r => !r.ok).length,
            mirrored: day.reduce((n, r) => n + (r.mirrored ?? 0), 0),
        },
        totalMirrored: published.length,
        pending,
        recent,
        runs,
    }
}

export type Status = Awaited<ReturnType<typeof getStatus>>

function blueskyUrl(uri: string): string {
    // at://<did>/app.bsky.feed.post/<rkey>
    const [, , did, , rkey] = uri.split('/')
    return `https://bsky.app/profile/${did}/post/${rkey}`
}

function ago(iso: string, now = Date.now()): string {
    const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
    if (s < 60) return `${s}s ago`
    const m = Math.round(s / 60)
    if (m < 60) return `${m} min ago`
    const h = Math.round(m / 60)
    if (h < 48) return `${h} h ago`
    return `${Math.round(h / 24)} days ago`
}

function esc(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

function time(iso: string | undefined | null, now: number): string {
    if (!iso) return '—'
    return `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(ago(iso, now))}</time>`
}

const LABELS: Record<Health, string> = {
    healthy: 'Healthy',
    attention: 'Needs attention',
    failing: 'Failing',
    stale: 'Stale',
    paused: 'Paused',
}

export function renderDashboard(s: Status): string {
    const now = new Date(s.generatedAt).getTime()
    const runResult = (r: state.Run) =>
        r.ok
            ? `${r.mirrored ?? 0} mirrored${r.remaining ? `, ${r.remaining} left` : ''}`
            : `failed: ${r.error ?? 'unknown error'}`

    // Oldest on the left, so the strip reads like a timeline.
    const strip = [...s.runs].reverse().map(r =>
        `<i class="${r.ok ? (r.mirrored ? 'posted' : 'ok') : 'err'}" title="${esc(`${r.at} · ${runResult(r)}`)}"></i>`
    ).join('')

    const recent = s.recent.map(p => `
        <li>
            <div class="post-text">${esc(p.text) || '<span class="muted">(no text)</span>'}</div>
            <div class="post-meta">
                ${time(p.createdAt, now)}
                ${p.media ? `· ${p.media} media` : ''}${p.quote ? ' · quote' : ''}
                · <a href="${esc(p.tweet)}">tweet</a> · <a href="${esc(p.bluesky)}">bluesky</a>
            </div>
        </li>`).join('')

    const runs = s.runs.slice(0, 12).map(r => `
        <tr class="${r.ok ? '' : 'row-err'}">
            <td>${time(r.at, now)}</td>
            <td>${esc(runResult(r))}</td>
            <td class="num">${r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</td>
        </tr>`).join('')

    const pending = s.pending.length
        ? `<section>
            <h2>Retrying</h2>
            <ul class="plain">${s.pending.map(p =>
            `<li><a href="https://x.com/${esc(s.user)}/status/${esc(p.guid)}">${esc(p.guid)}</a>: ${esc(p.attempts)} failed attempt${p.attempts > 1 ? 's' : ''}</li>`
        ).join('')}</ul>
        </section>`
        : ''

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${esc(LABELS[s.health])} · bradbot</title>
<style>
    :root {
        color-scheme: light dark;
        --bg: #f6f7f9; --card: #fff; --text: #1c1f24; --muted: #687080; --line: #e3e6eb;
        --ok: #1f9d55; --warn: #c27c0e; --bad: #d33a3a; --paused: #6b7280; --posted: #2f6fe4;
    }
    @media (prefers-color-scheme: dark) {
        :root {
            --bg: #111317; --card: #1a1d23; --text: #e6e8ec; --muted: #9aa1ad; --line: #2a2e36;
            --ok: #3ccf7a; --warn: #f0a53a; --bad: #f26b6b; --paused: #9ca3af; --posted: #6aa0ff;
        }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
    main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
    a { color: var(--posted); }
    .muted, .post-meta, footer { color: var(--muted); }
    header { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; }
    .dot { width: 14px; height: 14px; border-radius: 50%; flex: none; background: var(--c); box-shadow: 0 0 0 4px color-mix(in srgb, var(--c) 25%, transparent); }
    .healthy { --c: var(--ok); } .attention { --c: var(--warn); } .failing, .stale { --c: var(--bad); } .paused { --c: var(--paused); }
    h1 { font-size: 22px; margin: 0; }
    h1 small { font-weight: normal; color: var(--muted); font-size: 15px; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 10px; }
    section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 14px; }
    .summary { font-size: 17px; margin: 0; }
    .error { margin: 10px 0 0; padding: 10px; border-radius: 6px; background: color-mix(in srgb, var(--bad) 12%, transparent); font: 13px/1.4 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .stat b { display: block; font-size: 20px; }
    .stat span { color: var(--muted); font-size: 13px; }
    .strip { display: flex; gap: 1px; height: 28px; align-items: stretch; }
    .strip i { flex: 1; min-width: 1px; border-radius: 1px; background: var(--ok); opacity: .55; }
    .strip i.posted { background: var(--posted); opacity: 1; }
    .strip i.err { background: var(--bad); opacity: 1; }
    .legend { font-size: 12px; color: var(--muted); margin-top: 6px; }
    ul.posts, ul.plain { list-style: none; padding: 0; margin: 0; }
    ul.posts li { padding: 10px 0; border-top: 1px solid var(--line); }
    ul.posts li:first-child { border-top: 0; padding-top: 0; }
    .post-text { white-space: pre-wrap; word-break: break-word; }
    .post-meta { font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    td { padding: 6px 4px; border-top: 1px solid var(--line); vertical-align: top; word-break: break-word; }
    tr:first-child td { border-top: 0; }
    td.num { text-align: right; white-space: nowrap; color: var(--muted); }
    .row-err td { color: var(--bad); }
    footer { font-size: 12px; text-align: center; }
</style>
</head>
<body>
<main>
    <header class="${s.health}">
        <span class="dot" aria-hidden="true"></span>
        <h1>${esc(LABELS[s.health])} <small>@${esc(s.user)} → ${esc(s.target)}</small></h1>
    </header>

    <section class="${s.health}">
        <p class="summary">${esc(s.summary)}${s.running ? ' A run is in progress.' : ''}</p>
        ${s.lastRun && !s.lastRun.ok ? `<p class="error">${esc(s.lastRun.error)}</p>` : ''}
    </section>

    <section>
        <div class="stats">
            <div class="stat"><b>${time(s.lastRun?.at, now)}</b><span>last run</span></div>
            <div class="stat"><b>${time(s.lastSuccess?.at, now)}</b><span>last success</span></div>
            <div class="stat"><b>${s.last24h.mirrored}</b><span>mirrored, 24 h</span></div>
            <div class="stat"><b>${s.last24h.failed} / ${s.last24h.runs}</b><span>failed runs, 24 h</span></div>
            <div class="stat"><b>${s.totalMirrored}</b><span>mirrored in total</span></div>
            <div class="stat"><b>${esc(s.schedule)}</b><span>schedule (UTC)</span></div>
        </div>
    </section>

    <section>
        <h2>Runs</h2>
        ${s.runs.length ? `<div class="strip">${strip}</div>
        <div class="legend">last ${s.runs.length} runs, oldest left · green: nothing new · blue: posted · red: failed</div>` : '<p class="muted">No runs recorded yet.</p>'}
        ${runs ? `<table>${runs}</table>` : ''}
    </section>

    ${pending}

    <section>
        <h2>Latest mirrors</h2>
        ${recent ? `<ul class="posts">${recent}</ul>` : '<p class="muted">Nothing mirrored yet.</p>'}
    </section>

    <footer>
        updated ${time(s.generatedAt, now)}, refreshes every minute${s.build ? ` · build ${esc(s.build)}` : ''} ·
        <a href="/status.json">status.json</a>
    </footer>
</main>
<script>
    // Server-rendered times are relative; show the exact local time on hover.
    for (const t of document.querySelectorAll('time')) t.title = new Date(t.dateTime).toLocaleString()
</script>
</body>
</html>
`
}
