// Exercises login, tweet fetching, media download and blob upload without
// posting. Verifies credentials, cookies and the vendored python.
import { getAgent } from "../src/mirror.ts"
import { buildRichText } from "../src/util.ts"
import { getUserTweets } from "../src/twitter.ts"
import { config } from "../src/config.ts"
import { pythonPath, ffmpegPath } from "../src/bin.ts"

console.log('python:', await pythonPath())
console.log('ffmpeg:', await ffmpegPath())

const agent = await getAgent()
console.log('login OK as', agent.session?.handle, agent.session?.did)

const tweets = await getUserTweets(config.twitterUser, 5)
console.log('fetched', tweets.length, 'tweets; latest:', tweets[0]?.id)

const latest = tweets[0]!
const text = latest.text.replace(/https:\/\/t\.co\/\w+/g, '').trim()
const rt = await buildRichText(text, agent)
console.log('richtext OK:', JSON.stringify(rt.text), 'facets:', rt.facets?.length ?? 0)

for (const m of latest.media) {
    const res = await fetch(m.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    })
    const bytes = new Uint8Array(await res.arrayBuffer())
    const encoding = res.headers.get('content-type') || ''
    console.log('downloaded', m.type, bytes.length, 'bytes', encoding, `${m.width}x${m.height}`)
    if (m.type === 'photo') {
        const { data } = await agent.uploadBlob(bytes, { encoding })
        console.log('blob upload OK:', data.blob.ref.toString())
    }
}
console.log('dry run complete - nothing was posted')
