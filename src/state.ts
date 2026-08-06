// Mirror state lives in Deno KV. The filesystem isn't durable on Deploy — the
// isolated environment can be evicted between cron invocations — so posts.json
// wouldn't survive and the bot would re-mirror everything.
import type { Post } from './post.ts'

const kv = await Deno.openKv()

const POST_KEY = (guid: string) => ['post', guid]

export async function getPost(guid: string): Promise<Post | null> {
    const entry = await kv.get<Post>(POST_KEY(guid))
    return entry.value
}

export async function savePost(post: Post): Promise<void> {
    await kv.set(POST_KEY(post.guid), post)
}

export async function isEmpty(): Promise<boolean> {
    for await (const _ of kv.list({ prefix: ['post'] }, { limit: 1 })) {
        return false
    }
    return true
}

export async function seenGuids(): Promise<Set<string>> {
    const guids = new Set<string>()
    for await (const entry of kv.list<Post>({ prefix: ['post'] })) {
        guids.add(entry.key[1] as string)
    }
    return guids
}

// Only posts that were actually published have a uri; the rest were recorded as
// already-seen so they'd be skipped.
export async function publishedPosts(): Promise<Post[]> {
    const posts: Post[] = []
    for await (const entry of kv.list<Post>({ prefix: ['post'] })) {
        if (entry.value?.uri) posts.push(entry.value)
    }
    return posts
}

export async function clear(): Promise<number> {
    let count = 0
    for await (const entry of kv.list({ prefix: ['post'] })) {
        await kv.delete(entry.key)
        count++
    }
    for await (const entry of kv.list({ prefix: ['attempts'] })) {
        await kv.delete(entry.key)
    }
    await kv.delete(['lock'])
    await kv.delete(['backfill'])
    await kv.delete(['lastRun'])
    return count
}

// A pause flag in KV rather than an env var: the cron schedule is extracted at
// deploy time, so pausing via config would need a redeploy, and a redeploy can
// race with an in-flight run.
export async function isPaused(): Promise<boolean> {
    return (await kv.get<boolean>(['paused'])).value === true
}

export async function setPaused(paused: boolean): Promise<void> {
    if (paused) await kv.set(['paused'], true)
    else await kv.delete(['paused'])
}

/**
 * Best-effort mutual exclusion across timelines.
 *
 * Deno.cron won't overlap ticks within one timeline, but a due job "fires
 * independently on each timeline where it's registered" — so adding a git branch
 * timeline later would run a second poster against the same KV state and could
 * double-post. The lock expires rather than being purely released, because an
 * isolate killed for exceeding its memory limit never runs cleanup.
 */
interface Lock {
    holder: string
    expiresAt: string
}

/** Returns the holder id on success, null if someone else holds a live lock. */
export async function acquireLock(ttlSeconds: number): Promise<string | null> {
    const key = ['lock']
    const existing = await kv.get<Lock>(key)
    if (existing.value && new Date(existing.value.expiresAt).getTime() > Date.now()) {
        return null
    }
    const holder = crypto.randomUUID()
    // The versionstamp check makes this atomic against a concurrent acquirer.
    const result = await kv.atomic()
        .check(existing)
        .set(key, { holder, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() })
        .commit()
    return result.ok ? holder : null
}

/**
 * Whether this run still owns the lock.
 *
 * A cron run on a superseded revision keeps executing after a redeploy — it has
 * already passed every startup check, so it will happily work through the queue it
 * built in memory, posting against state that has since been reset. Re-checking
 * ownership as it goes gives such a run a way to notice it has been displaced.
 */
export async function holdsLock(holder: string): Promise<boolean> {
    return (await kv.get<Lock>(['lock'])).value?.holder === holder
}

/** Only clears the lock if this run still owns it, never a successor's. */
export async function releaseLock(holder: string): Promise<void> {
    const existing = await kv.get<Lock>(['lock'])
    if (existing.value?.holder !== holder) return
    await kv.atomic().check(existing).delete(['lock']).commit()
}

// Attempt counts live outside the post namespace so a tweet mid-retry isn't
// treated as already seen. An isolate killed for exceeding its memory limit dies
// without running any error handling, so this is the only way a doomed tweet
// can be detected across runs instead of blocking the queue forever.
export async function bumpAttempts(guid: string): Promise<number> {
    const key = ['attempts', guid]
    const attempts = ((await kv.get<number>(key)).value ?? 0) + 1
    await kv.set(key, attempts)
    return attempts
}

export async function clearAttempts(guid: string): Promise<void> {
    await kv.delete(['attempts', guid])
}

// Backfill spans several cron invocations, so its window and progress outlive a
// single run.
export interface Backfill {
    cutoff: string
    done: boolean
}

export async function getBackfill(): Promise<Backfill | null> {
    return (await kv.get<Backfill>(['backfill'])).value
}

export async function setBackfill(backfill: Backfill): Promise<void> {
    await kv.set(['backfill'], backfill)
}

export async function setLastRun(summary: unknown): Promise<void> {
    await kv.set(['lastRun'], { at: new Date().toISOString(), ...(summary as object) })
}

export async function getLastRun(): Promise<unknown> {
    return (await kv.get(['lastRun'])).value
}
