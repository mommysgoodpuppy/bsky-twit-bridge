export interface Post {
    description: string,
    guid: string,
    media?: Array<{
        type: string,
        url: string,
        width?: number | null,
        height?: number | null,
        durationMillis?: number | null
    }>,
    // Original tweet time, used as the Bluesky record's createdAt so backfilled
    // posts land in the right place in the timeline.
    createdAt?: string,
    // Id of the tweet this one quotes, if any.
    quotedGuid?: string | null,
    // The Bluesky record this was mirrored to. Absent for tweets that were only
    // recorded as already-seen, which is why a quote of one can't be resolved.
    uri?: string,
    cid?: string
}
