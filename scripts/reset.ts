// Local reset: deletes every post the bot made and clears the LOCAL KV.
//
// Note this does not touch the deployed app's state — Deploy's KV isn't reachable
// from outside the deployment — so for the deployed bot use POST /reset instead.
import { resetAll } from "../src/admin.ts"

const { deleted, stateEntries } = await resetAll()
console.log(`deleted ${deleted} posts, cleared ${stateEntries} local state entries`)
