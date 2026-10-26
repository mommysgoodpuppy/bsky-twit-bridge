import { AtpAgent } from "@atproto/api"
import { buildRichText } from "./util.ts"
import * as state from "./state.ts"
import type { Post } from "./post.ts"
import { getUserTweets, type TweetData } from "./twitter.ts"
import { compressVideo } from "./video.ts"
import { config } from "./config.ts"

let agent: AtpAgent | null = null

export async function getAgent(): Promise<AtpAgent> {
    if (agent) return agent
    const created = new AtpAgent({ service: 'https://bsky.social' })
    await created.login({
        identifier: config.bskyUsername,
        password: config.bskyPassword,
    })
    agent = created
    return created
}

function toPost(tweet: TweetData): Post {
    return {
        description: tweet.text.replace(/https:\/\/t\.co\/\w+/g, '').trim(),
        guid: tweet.id,
        media: tweet.media.map(m => ({
            type: m.type === 'video' ? 'video' as const : 'photo' as const,
            url: m.url,
            width: m.width,
            height: m.height,
            durationMillis: m.duration_millis
        })),
        createdAt: new Date(tweet.created_at).toISOString(),
        quotedGuid: tweet.quoted_id ?? null
    }
}

// Bluesky renders a centre-cropped square when an embed has no aspectRatio.
function aspectRatio(item: { width?: number | null, height?: number | null }) {
    if (!item.width || !item.height) return undefined
    return { width: item.width, height: item.height }
}

async function fetchMedia(url: string): Promise<[Uint8Array, string] | null> {
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        })
        if (!response.ok) return null
        const contentType = response.headers.get('content-type') || ''
        if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
            return null
        }
        return [new Uint8Array(await response.arrayBuffer()), contentType]
    } catch {
        return null
    }
}

async function uploadVideo(agent: AtpAgent, post: Post, video: NonNullable<Post['media']>[number]) {
    const videoPath = await Deno.makeTempFile({ suffix: '.mp4' })
    try {
        const duration = video.durationMillis ? video.durationMillis / 1000 : null
        await compressVideo(video.url, videoPath, duration)
        const videoSize = (await Deno.stat(videoPath)).size

        const didDoc = await agent.com.atproto.identity.resolveHandle({
            handle: agent.session?.handle || ''
        })
        const didDocResponse = await fetch(`https://plc.directory/${didDoc.data.did}`)
        const didDocData = await didDocResponse.json()
        const pdsEndpoint = didDocData.service?.find((s: { id: string }) => s.id === '#atproto_pds')?.serviceEndpoint
        const pdsHost = new URL(pdsEndpoint).host

        const serviceAuth = await agent.com.atproto.server.getServiceAuth({
            aud: `did:web:${pdsHost}`,
            lxm: 'com.atproto.repo.uploadBlob',
            exp: Math.floor(Date.now() / 1000) + 60 * 30,
        })

        const uploadUrl = new URL('https://video.bsky.app/xrpc/app.bsky.video.uploadVideo')
        uploadUrl.searchParams.append('did', agent.session?.did || '')
        uploadUrl.searchParams.append('name', `${post.guid}.mp4`)
        // Streamed off disk instead of read into memory: a transcode is allowed up
        // to 100MB and the isolate only has 768MB in total.
        const videoFile = await Deno.open(videoPath, { read: true })
        const uploadResponse = await fetch(uploadUrl.toString(), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${serviceAuth.data.token}`,
                'Content-Type': 'video/mp4',
                'Content-Length': videoSize.toString()
            },
            body: videoFile.readable
        })
        if (!uploadResponse.ok) {
            throw new Error(`Video upload failed: ${uploadResponse.status}`)
        }

        const jobStatus = await uploadResponse.json()
        let blob = jobStatus.blob
        let attempts = 0
        // Bluesky's video service regularly needs longer than a minute for a
        // 20MB+ clip; 60s here was giving up on videos that would have landed.
        while (!blob && attempts < config.videoJobTimeoutSeconds) {
            await new Promise(resolve => setTimeout(resolve, 1000))
            attempts++
            const statusResponse = await fetch(
                `https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=${jobStatus.jobId}`,
                { headers: { 'Authorization': `Bearer ${serviceAuth.data.token}` } }
            )
            const status = await statusResponse.json()
            if (status.jobStatus?.blob) blob = status.jobStatus.blob
            if (status.jobStatus?.state === 'JOB_STATE_FAILED') {
                throw new Error('Video processing failed')
            }
        }
        if (!blob) throw new Error('Video processing timed out')

        return {
            $type: 'app.bsky.embed.video',
            video: blob,
            alt: post.description.slice(0, 1000),
            aspectRatio: aspectRatio(video)
        }
    } finally {
        await Deno.remove(videoPath).catch(() => {})
    }
}

export async function pushPost(post: Post, quotedRef?: { uri: string, cid: string }) {
    const agent = await getAgent()

    const images = []
    let videoEmbed = null

    if (post.media) {
        const firstVideo = post.media.find(m => m.type === 'video')
        if (firstVideo) {
            try {
                videoEmbed = await uploadVideo(agent, post, firstVideo)
            } catch (error) {
                console.error('video failed for', post.guid, error instanceof Error ? error.message : error)
            }
        } else {
            for (const item of post.media) {
                if (images.length >= 4) break
                if (item.type !== 'photo') continue
                try {
                    const result = await fetchMedia(item.url)
                    if (!result) continue
                    const [imageArray, encoding] = result
                    const { data } = await agent.uploadBlob(imageArray, { encoding })
                    images.push({
                        alt: '',
                        image: data.blob,
                        aspectRatio: aspectRatio(item)
                    })
                } catch (error) {
                    console.error('image failed for', post.guid, error instanceof Error ? error.message : error)
                }
            }
        }
    }

    const rt = await buildRichText(post.description, agent)

    let media = undefined
    if (videoEmbed) {
        media = videoEmbed
    } else if (images.length > 0) {
        media = { $type: 'app.bsky.embed.images', images }
    }

    let embed: { [k: string]: unknown, $type: string } | undefined = media
    if (quotedRef) {
        const record = { $type: 'app.bsky.embed.record', record: quotedRef }
        // A quote plus its own media has to go in a single combined embed.
        embed = media
            ? { $type: 'app.bsky.embed.recordWithMedia', record, media }
            : record
    }

    return await agent.post({
        text: rt.text,
        facets: rt.facets,
        embed,
        createdAt: post.createdAt || new Date().toISOString()
    })
}

export async function checkNewPosts(holder: string) {
    let backfill = await state.getBackfill()

    if (!backfill) {
        // First run ever. Fix the backfill window now so later runs agree on it
        // even as the cutoff recedes into the past.
        backfill = {
            cutoff: new Date(Date.now() - config.backfillDays * 86400000).toISOString(),
            done: config.backfillDays <= 0,
        }
        await state.setBackfill(backfill)
    }

    // A 30-day window can be dozens of tweets, which won't fit in one cron
    // invocation, so keep pulling the wide page until the backfill is finished.
    const tweets = await getUserTweets(
        config.twitterUser,
        backfill.done ? config.fetchCount : config.backfillFetchCount,
    )
    if (!tweets || tweets.length === 0) return { mirrored: 0, skipped: 0, backfilling: !backfill.done }

    const seen = await state.seenGuids()
    let pending = tweets.filter(t => !seen.has(t.id))
    let skipped: TweetData[] = []

    if (!backfill.done) {
        // Anything older than the window is recorded as seen rather than posted.
        const cutoff = new Date(backfill.cutoff).getTime()
        const inWindow = (t: TweetData) => new Date(t.created_at).getTime() >= cutoff
        skipped = pending.filter(t => !inWindow(t))
        pending = pending.filter(inWindow)
        for (const tweet of skipped) {
            await state.savePost(toPost(tweet))
        }
        console.log(`backfill: ${pending.length} to go, recording ${skipped.length} as out of window`)
    }

    if (pending.length === 0) {
        console.log('no new posts')
        if (!backfill.done) {
            await state.setBackfill({ ...backfill, done: true })
            console.log('backfill complete')
        }
        return { mirrored: 0, skipped: skipped.length, backfilling: false }
    }

    // Cap the work per invocation. The rest resumes on the next cron tick, since
    // progress is recorded in KV as each post lands.
    const total = pending.length
    let capped = false
    if (pending.length > config.maxPostsPerRun) {
        // Oldest first, so trim from the newest end.
        pending = pending.slice(pending.length - config.maxPostsPerRun)
        capped = true
    }

    // Twitter returns newest first; mirror oldest first so Bluesky reads in order
    // (and so a quoted tweet is mirrored before the tweet quoting it).
    let mirrored = 0
    for (const tweet of pending.reverse()) {
        // Re-checked every iteration, not just at startup, so a run left over from
        // a superseded revision stops instead of posting against reset state.
        if (!(await state.holdsLock(holder))) {
            console.log('lock lost (superseded or reset); abandoning run')
            break
        }
        if (await state.isPaused()) {
            console.log('paused mid-run; stopping')
            break
        }
        // Guards against a concurrent run having already handled this tweet.
        if ((await state.getPost(tweet.id))?.uri) {
            console.log('already mirrored', tweet.id, '; skipping')
            continue
        }

        const post = toPost(tweet)

        // Turn a quote tweet into a Bluesky quote post, but only when the quoted
        // tweet is one we actually mirrored. Quotes of other accounts, or of
        // tweets older than the backfill window, fall back to a plain post.
        let quotedRef = undefined
        if (post.quotedGuid) {
            const quoted = await state.getPost(post.quotedGuid)
            if (quoted?.uri && quoted.cid) {
                quotedRef = { uri: quoted.uri, cid: quoted.cid }
            } else {
                console.log('quoted tweet', post.quotedGuid, 'not mirrored; posting without quote')
            }
        }

        // Recorded before posting, so a tweet whose video kills the isolate is
        // retried without it rather than blocking every later tweet forever.
        const attempts = await state.bumpAttempts(tweet.id)
        const skipVideo = attempts > config.maxAttemptsWithVideo
        if (skipVideo && post.media?.some(m => m.type === 'video')) {
            console.log(`tweet ${tweet.id} failed ${attempts - 1}x; posting without video`)
            post.media = post.media.filter(m => m.type !== 'video')
        }

        try {
            const result = await pushPost(post, quotedRef)
            post.uri = result.uri
            post.cid = result.cid
            mirrored++
            console.log('mirrored', tweet.id, quotedRef ? '(quote)' : '')
        } catch (error) {
            console.error('failed to mirror', tweet.id, error)
            continue
        }
        await state.savePost(post)
        await state.clearAttempts(tweet.id)
    }

    if (!backfill.done && !capped) {
        await state.setBackfill({ ...backfill, done: true })
        console.log('backfill complete')
    }

    return {
        mirrored,
        skipped: skipped.length,
        remaining: total - mirrored,
        backfilling: !backfill.done && capped,
    }
}

/**
 * `force` is for an explicit manual trigger: it ignores the pause flag, so the
 * backfill can be stepped through one run at a time with cron held off. The lock
 * is still respected, so it can't collide with a run already in progress.
 */
export async function runMirror({ force = false }: { force?: boolean } = {}) {
    if (!force && await state.isPaused()) {
        console.log('paused; skipping')
        return { mirrored: 0, skipped: 0, paused: true }
    }
    const holder = await state.acquireLock(config.lockTtlSeconds)
    if (!holder) {
        console.log('another run holds the lock; skipping')
        return { mirrored: 0, skipped: 0, lockHeld: true }
    }
    const started = Date.now()
    try {
        const summary = await checkNewPosts(holder)
        await state.setLastRun({ ok: true, ...summary, durationMs: Date.now() - started })
        return summary
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('mirror run failed:', message)
        await state.setLastRun({ ok: false, error: message, durationMs: Date.now() - started })
        throw error
    } finally {
        await state.releaseLock(holder)
    }
}
