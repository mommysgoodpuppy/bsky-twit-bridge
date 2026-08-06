// Warms vendor/ during the Deploy build so the first cron tick doesn't have to
// download ~100MB itself. The runtime can still fetch them on demand if the
// build's files don't reach it, so this is a speedup rather than a requirement.
import { vendorAll } from "../src/bin.ts"

await vendorAll()
