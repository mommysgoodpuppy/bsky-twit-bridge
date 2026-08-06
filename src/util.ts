import { type AtpAgent, RichText } from "@atproto/api"

export async function buildRichText(text: string, agent: AtpAgent) {
    const rt = new RichText({ text })
    await rt.detectFacets(agent)
    return rt
}
