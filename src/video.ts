// Transcodes tweet videos into something Bluesky's video service accepts.
// fluent-ffmpeg is gone: it resolves binaries off PATH and pulls in node
// compatibility for what amounts to building an argv, so we invoke the vendored
// ffmpeg directly. ffprobe is gone too — the duration it was called for comes
// from the tweet payload.
import { ffmpegPath } from './bin.ts'

const MAX_SIZE = 100 * 1024 * 1024
const MAX_DURATION = 180

function args(input: string, output: string, trimDuration: number, second: boolean) {
    return [
        '-y',
        '-i', input,
        // One thread: libx264 allocates per-thread frame buffers, and the whole
        // environment shares a 768MB budget with the Deno runtime.
        '-threads', '1',
        '-c:v', 'libx264',
        '-profile:v', 'main',
        ...(second ? [] : ['-level:v', '4.0']),
        '-crf', second ? '28' : '23',
        '-preset', second ? 'fast' : 'medium',
        '-c:a', 'aac',
        '-b:a', second ? '96k' : '128k',
        '-ar', '48000',
        '-ac', '2',
        // The trailing scale rounds both dimensions down to even numbers. h264
        // rejects odd ones, and force_original_aspect_ratio=decrease happily
        // produces them for portrait clips (a real 771x1080 tweet hit this).
        // scale's own force_divisible_by would be tidier but needs ffmpeg 4.2+,
        // and the vendored build is 4.1.
        '-vf',
        (second
            ? "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease"
            : "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease") +
        ",scale='trunc(iw/2)*2':'trunc(ih/2)*2',format=yuv420p",
        '-movflags', '+faststart',
        ...(second ? [] : ['-max_muxing_queue_size', '1024']),
        '-t', trimDuration.toString(),
        output,
    ]
}

async function transcode(ffmpeg: string, input: string, output: string, trimDuration: number, second: boolean) {
    const { code, stderr } = await new Deno.Command(ffmpeg, {
        args: args(input, output, trimDuration, second),
        stdout: 'null',
        stderr: 'piped',
    }).output()
    if (code !== 0) {
        const tail = new TextDecoder().decode(stderr).trim().split('\n').slice(-5).join('\n')
        throw new Error(`ffmpeg exited ${code}: ${tail}`)
    }
}

/**
 * Downloads and transcodes a video. `durationSeconds` comes from the tweet's
 * video_info; when it's unknown we just don't trim.
 */
export async function compressVideo(
    inputUrl: string,
    outputPath: string,
    durationSeconds?: number | null,
): Promise<string> {
    const ffmpeg = await ffmpegPath()

    const response = await fetch(inputUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    })
    if (!response.ok || !response.body) {
        throw new Error(`video download failed: ${response.status}`)
    }

    const tempInput = outputPath + '.input.mp4'
    // Streamed rather than buffered; the isolate's 768MB has to cover ffmpeg too.
    const inputFile = await Deno.create(tempInput)
    await response.body.pipeTo(inputFile.writable)

    try {
        const trimDuration = Math.min(durationSeconds || MAX_DURATION, MAX_DURATION)
        await transcode(ffmpeg, tempInput, outputPath, trimDuration, false)

        // Still too big for Bluesky: go again, smaller and cheaper.
        if ((await Deno.stat(outputPath)).size > MAX_SIZE) {
            await transcode(ffmpeg, tempInput, outputPath, trimDuration, true)
        }
        return outputPath
    } finally {
        await Deno.remove(tempInput).catch(() => {})
    }
}
