// One mirror pass, then exit. No cron, no HTTP server.
import { runMirror } from "../src/mirror.ts"

const summary = await runMirror()
console.log(summary)
