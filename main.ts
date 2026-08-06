// Deno Deploy entrypoint. The mirror runs on a cron schedule rather than a
// constantly-running interval, so there's no long-lived process to keep alive;
// the HTTP handler reports the last run and exposes the operational controls.
import { runMirror } from "./src/mirror.ts"
import { resetAll } from "./src/admin.ts"
import { config } from "./src/config.ts"
import * as state from "./src/state.ts"

// Deno.cron won't start a run while the previous one is still going. It fires on
// production and git branch timelines, but not on preview revisions, so ordinary
// deploys don't leave extra posters running.
Deno.cron("mirror tweets", config.cronSchedule, async () => {
    console.log('cron: mirroring', config.twitterUser)
    await runMirror()
})

// Every mutating route is gated on RUN_TOKEN; without it they 404, so a public
// URL can't trigger posting or deletion.
function authorised(req: Request): Response | null {
    const token = Deno.env.get('RUN_TOKEN')
    if (!token) return new Response('not enabled', { status: 404 })
    if (req.headers.get('authorization') !== `Bearer ${token}`) {
        return new Response('unauthorized', { status: 401 })
    }
    return null
}

Deno.serve(async (req) => {
    const url = new URL(req.url)

    if (req.method === 'POST') {
        const denied = authorised(req)
        if (denied) return denied

        switch (url.pathname) {
            // Manual kick, so a backfill needn't wait for the next tick. Runs even
            // while paused, for stepping through a backfill under supervision.
            //
            // Only suitable for quick steps: a request-scoped isolate is killed
            // well before a video transcode finishes, which strands the run
            // part-done and holds the lock until it lapses. Video-heavy backfills
            // belong to cron, which tolerates multi-minute runs.
            case '/run':
                return Response.json(await runMirror({ force: true }))

            case '/pause':
                await state.setPaused(true)
                return Response.json({ paused: true })

            case '/resume':
                await state.setPaused(false)
                return Response.json({ paused: false })

            // Deletes every post the bot made and clears its state, so the next
            // run backfills from scratch. Destructive.
            case '/reset':
                return Response.json(await resetAll())
        }
    }

    return Response.json({
        user: config.twitterUser,
        target: config.bskyUsername,
        schedule: config.cronSchedule,
        backfillDays: config.backfillDays,
        paused: await state.isPaused(),
        lastRun: await state.getLastRun(),
    })
})
