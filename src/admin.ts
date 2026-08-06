// Operational controls. These have to be reachable in the deployment because
// Deploy's KV isn't accessible from outside it, so a local reset script would
// only ever clear a local SQLite KV.
import { getAgent } from "./mirror.ts"
import * as state from "./state.ts"

/** Deletes every post the bot has made, paging through the whole feed. */
export async function deleteAllPosts(): Promise<number> {
    const agent = await getAgent()
    const did = agent.session!.did
    let deleted = 0
    let cursor: string | undefined = undefined

    // Deleting shrinks the feed under us, so keep fetching from the start until a
    // page comes back with nothing of ours left.
    while (true) {
        const feed = await agent.getAuthorFeed({ actor: did, limit: 100, cursor })
        const own = feed.data.feed.filter(item => item.post.author.did === did)
        if (own.length === 0) {
            if (!feed.data.cursor) break
            cursor = feed.data.cursor
            continue
        }
        for (const item of own) {
            await agent.deletePost(item.post.uri)
            deleted++
        }
        cursor = undefined
    }
    return deleted
}

export async function resetAll(): Promise<{ deleted: number, stateEntries: number }> {
    const deleted = await deleteAllPosts()
    const stateEntries = await state.clear()
    return { deleted, stateEntries }
}
