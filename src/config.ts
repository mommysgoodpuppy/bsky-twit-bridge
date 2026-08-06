// Configuration comes from the environment. On Deno Deploy these are dashboard
// secrets; locally, `deno task` reads .env via --env-file or the shell.

function required(name: string): string {
    const value = Deno.env.get(name)
    if (!value) {
        console.error(`missing env var ${name}`)
        Deno.exit(1)
    }
    return value
}

export const config = {
    bskyUsername: required('BSKY_USERNAME'),
    bskyPassword: required('BSKY_PASSWORD'),
    twitterUser: required('TWITTER_USER'),
    // Twitter session cookies. Kept in env rather than a committed cookies.json
    // so they can be rotated as Deploy secrets.
    ct0: required('TWITTER_CT0'),
    authToken: required('TWITTER_AUTH_TOKEN'),
    // On the first run, mirror tweets from this many days back. 0 disables
    // backfill: the existing timeline is recorded as seen and only new tweets
    // get mirrored.
    backfillDays: parseInt(Deno.env.get('BACKFILL_DAYS') || '0'),
    // How many tweets to pull per poll. This is also the recovery window: after
    // an outage the mirror catches up by diffing the latest page against what it
    // has already seen, so anything that scrolled past this count is lost. Wide
    // enough here to absorb several days of downtime.
    fetchCount: parseInt(Deno.env.get('FETCH_COUNT') || '60'),
    backfillFetchCount: parseInt(Deno.env.get('BACKFILL_FETCH_COUNT') || '100'),
    // Ceiling on posts per invocation, so a long backfill doesn't run past
    // whatever budget a cron invocation gets. The remainder resumes next tick.
    maxPostsPerRun: parseInt(Deno.env.get('MAX_POSTS_PER_RUN') || '10'),
    // After this many failed attempts a tweet is mirrored without its video, on
    // the assumption the video is what's killing the run.
    maxAttemptsWithVideo: parseInt(Deno.env.get('MAX_ATTEMPTS_WITH_VIDEO') || '2'),
    // How long to wait for Bluesky to finish processing an uploaded video.
    videoJobTimeoutSeconds: parseInt(Deno.env.get('VIDEO_JOB_TIMEOUT_SECONDS') || '240'),
    // Lock lifetime: long enough to cover the slowest observed run (a video-heavy
    // backfill tick has taken over 6 minutes) without stranding the lock for ages
    // when a run is killed mid-flight, since that skips cron ticks until it lapses.
    lockTtlSeconds: parseInt(Deno.env.get('LOCK_TTL_SECONDS') || '600'),
    cronSchedule: Deno.env.get('CRON_SCHEDULE') || '*/5 * * * *',
}

let cookiePath: string | null = null

// twikit wants a cookies file, so materialise one from the env on first use.
export async function getCookiePath(): Promise<string> {
    if (cookiePath) return cookiePath
    const path = await Deno.makeTempFile({ suffix: '.json' })
    await Deno.writeTextFile(
        path,
        JSON.stringify({ ct0: config.ct0, auth_token: config.authToken }),
    )
    cookiePath = path
    return path
}
