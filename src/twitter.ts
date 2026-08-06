import { pythonPath } from './bin.ts'
import { getCookiePath } from './config.ts'

export interface TweetData {
  id: string;
  text: string;
  media: Array<{
    type: string;
    url: string;
    width?: number | null;
    height?: number | null;
    duration_millis?: number | null;
  }>;
  created_at: string;
  // Id of the tweet this one quotes, if any.
  quoted_id?: string | null;
}

export async function getUserTweets(username: string, count: number = 10): Promise<TweetData[]> {
  const python = await pythonPath()
  const cookies = await getCookiePath()

  const { code, stdout, stderr } = await new Deno.Command(python, {
    args: ['get_tweets.py', username, count.toString(), cookies],
    stdout: 'piped',
    stderr: 'piped'
  }).output()

  const out = new TextDecoder().decode(stdout)
  const err = new TextDecoder().decode(stderr)

  if (code !== 0) {
    throw new Error(`get_tweets.py exited with code ${code}: ${err}`)
  }

  let result
  try {
    result = JSON.parse(out)
  } catch {
    throw new Error(`Failed to parse JSON: ${out}`)
  }
  if (result.error) {
    // An expired X session and a broken scraper look identical from the outside
    // (both just stop mirroring), so name this one explicitly — it's the only
    // failure mode that needs a human to go get new cookies.
    if (/status: 401|"code":\s*32/.test(result.error)) {
      throw new Error(
        `X rejected the session cookies (${result.error.trim()}). ` +
        'Refresh TWITTER_CT0 and TWITTER_AUTH_TOKEN.'
      )
    }
    throw new Error(result.error)
  }
  return result
}
