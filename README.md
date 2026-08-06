# bsky-twit-bridge

A bot that mirrors a Twitter/X account to Bluesky — text, images, video and quote
posts — running on Deno Deploy as a cron job.

## how it runs

`main.ts` registers a `Deno.cron` job and a small HTTP handler. There's no
long-lived polling process: each tick fetches the timeline, mirrors anything new,
and exits. `Deno.cron` won't start a tick while the previous one is still running.

`GET /` reports the last run. `POST /run` triggers a run manually (useful for
kicking off the first backfill) and is disabled unless `RUN_TOKEN` is set.

State lives in **Deno KV**, not a file — Deploy's filesystem isn't durable between
invocations, so a posts.json would be lost and everything would be re-mirrored.

## deploying

The `deploy` block in deno.json holds the whole app config — specifying anything
there means Deploy ignores the dashboard settings:

```jsonc
"deploy": {
  "build": "deno task build",
  "runtime": { "type": "dynamic", "entrypoint": "main.ts" }
}
```

Cron and KV need no flags on Deploy (the local tasks pass `--unstable-cron` and
`--unstable-kv` because they're still gated in the CLI). Two things do need doing in
the dashboard: **provision a KV database** for the app under Databases, and set the
env vars from .env.example as secrets.

## subprocesses and vendored binaries

Tweet fetching is Python (`get_tweets.py` + twikit) and video transcoding is ffmpeg.
Deploy's runtime can spawn subprocesses, but the toolchain in the image isn't
contractual, so the bridge brings its own:

- CPython 3.11 standalone (~31MB) with twikit installed into its site-packages
- ffmpeg (~68MB), from the `@ffmpeg-installer/linux-x64` npm tarball

Both are gzip tarballs, extracted with the `tar` in the build image. `src/bin.ts`
resolves them in three tiers: a `vendor/` copy from the build, else a download into a
writable cache dir, else `python`/`ffmpeg` from PATH. The middle tier matters because
the docs don't promise that files written during the build reach the runtime, and the
runtime environment can be evicted regardless — so the first tick after an eviction
pays the download and later ticks reuse it. `deno task vendor` during the build is
therefore a speedup, not a requirement.

The PATH tier is what local development on a non-linux machine uses.

ffprobe isn't vendored — the only thing the transcode needed it for was the video
duration, and Twitter reports that in the tweet payload.

## setup

- copy .env.example to .env and fill it in
- Twitter cookies (ct0, auth_token) go in `TWITTER_CT0` / `TWITTER_AUTH_TOKEN`
  rather than a cookies.json, so they can be rotated as Deploy secrets
- locally: `pip install twikit`, and have ffmpeg on PATH for video posts

## tasks

- `deno task start` — cron + HTTP server, as Deploy runs it
- `deno task mirror` — one mirror pass, then exit
- `deno task dryrun` — login, fetch, transcode and blob upload without posting
- `deno task reset` — delete every post the bot made and clear state (destructive)
- `deno task vendor` — fetch the vendored binaries

## backfill

`BACKFILL_DAYS` mirrors that many days of existing tweets on first run; backfilled
posts keep their original tweet timestamps, so they land at the right dates in the
Bluesky timeline. 0 disables it — the current timeline is recorded as already-seen
and only new tweets get mirrored.

A month can be dozens of tweets, more than one cron tick should chew through, so
`MAX_POSTS_PER_RUN` caps each run and the rest resumes on the next tick. The window
and progress are stored in KV, so the cutoff doesn't drift between runs.

Note that twikit returns one page (~20 tweets) per request regardless of the count
asked for, so `get_tweets.py` pages through until it has enough, up to a hard
`MAX_TWEETS` ceiling.

## quote tweets

A quote tweet becomes a real Bluesky quote post, pointing at the bridge's own mirror
of the quoted tweet (combined with the quoting tweet's own image/video as a
`recordWithMedia` embed when it has one). This only works when the quoted tweet was
itself mirrored — KV stores each mirror's `uri`/`cid` for exactly this. Quotes of
other accounts, or of tweets older than the backfill window, fall back to a plain
post. Since posting goes oldest-first, quote chains inside the window resolve.

Images and videos carry an `aspectRatio`; without it Bluesky centre-crops to a
square.

## notes

`x_patch.py` keeps twikit working against X's current responses; see the comments in
that file. If tweet fetching starts failing with "Couldn't get KEY_BYTE indices" or a
KeyError, that patch is the place to look.
