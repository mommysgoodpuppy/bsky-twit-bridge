/**
 * Resolves the binaries the mirror shells out to: CPython (for twikit) and
 * ffmpeg.
 *
 * `deno task vendor` fetches these during the Deploy build, but the docs don't
 * promise that files written by the build reach the runtime environment, and the
 * runtime environment can be evicted anyway. So resolution is three-tiered:
 *
 *   1. a vendored copy from the build, if it's there
 *   2. otherwise download it into a writable cache dir, once per environment
 *   3. otherwise (non-linux-x64) fall back to PATH, which is local development
 *
 * Tier 2 means the first cron tick after an eviction pays a ~100MB download and
 * later ticks reuse it.
 */

const PYTHON_RELEASE = "20260728"
const PYTHON_VERSION = "3.11.15"
const FFMPEG_VERSION = "4.1.0"

const BUILD_VENDOR = "vendor"

function cacheDir(): string {
    const configured = Deno.env.get("VENDOR_DIR")
    if (configured) return configured
    const tmp = Deno.env.get("TMPDIR") || "/tmp"
    return `${tmp}/bsky-twit-bridge-vendor`
}

function canVendor(): boolean {
    if (Deno.env.get("FORCE_VENDOR") === "1") return true
    return Deno.build.os === "linux" && Deno.build.arch === "x86_64"
}

async function exists(path: string): Promise<boolean> {
    try {
        await Deno.stat(path)
        return true
    } catch {
        return false
    }
}

async function run(cmd: string, args: string[]) {
    const { code, stderr } = await new Deno.Command(cmd, {
        args,
        stdout: "inherit",
        stderr: "piped",
    }).output()
    if (code !== 0) {
        const message = new TextDecoder().decode(stderr).trim().split("\n").slice(-5).join("\n")
        throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${message}`)
    }
}

async function untar(url: string, dest: string, suffix: string) {
    const res = await fetch(url)
    if (!res.ok || !res.body) {
        throw new Error(`download failed: ${res.status} ${res.statusText} — ${url}`)
    }
    const tarball = await Deno.makeTempFile({ suffix })
    // Streamed to disk rather than buffered: these tarballs are 31MB and 65MB,
    // and an isolate only gets 768MB with the video work happening alongside.
    const file = await Deno.create(tarball)
    await res.body.pipeTo(file.writable)
    await Deno.mkdir(dest, { recursive: true })
    try {
        // Both sources wrap their contents in one directory level. `tar` and
        // `gzip` are both present in the build image.
        await run("tar", ["-xzf", tarball, "-C", dest, "--strip-components=1"])
    } finally {
        await Deno.remove(tarball).catch(() => {})
    }
}

async function installPython(dir: string): Promise<string> {
    const bin = `${dir}/bin/python3`
    if (!(await exists(bin))) {
        // The "stripped" install_only build is ~31MB versus ~49MB, and ships pip.
        console.log(`bin: fetching python ${PYTHON_VERSION} into ${dir}`)
        await untar(
            `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
            dir,
            ".tar.gz",
        )
        if (!(await exists(bin))) throw new Error(`expected ${bin} after extraction`)
        await Deno.chmod(bin, 0o755)
    }

    // twikit goes into this interpreter's own site-packages, so nothing needs
    // PYTHONPATH at runtime.
    const check = await new Deno.Command(bin, {
        args: ["-c", "import twikit"],
        stdout: "null",
        stderr: "null",
    }).output()
    if (check.code !== 0) {
        console.log("bin: installing twikit")
        await run(bin, ["-m", "pip", "install", "--no-cache-dir", "twikit"])
    }
    return bin
}

async function installFfmpeg(dir: string): Promise<string> {
    const bin = `${dir}/ffmpeg`
    if (!(await exists(bin))) {
        // ffprobe isn't fetched: the only thing the transcode needed it for was
        // the video duration, and Twitter reports that in the tweet payload.
        console.log(`bin: fetching ffmpeg ${FFMPEG_VERSION} into ${dir}`)
        await untar(
            `https://registry.npmjs.org/@ffmpeg-installer/linux-x64/-/linux-x64-${FFMPEG_VERSION}.tgz`,
            dir,
            ".tgz",
        )
        if (!(await exists(bin))) throw new Error(`expected ${bin} after extraction`)
        await Deno.chmod(bin, 0o755)
    }
    return bin
}

/** Memoised so concurrent callers don't race on the same download. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | null = null
    return () => (pending ??= fn())
}

function resolver(
    buildPath: string,
    cachePath: string,
    install: (dir: string) => Promise<string>,
    fallback: string,
) {
    return once(async () => {
        if (await exists(`${BUILD_VENDOR}/${buildPath}`)) {
            return `${BUILD_VENDOR}/${buildPath}`
        }
        if (!canVendor()) return fallback
        return await install(`${cacheDir()}/${cachePath}`)
    })
}

export const pythonPath = resolver("python/bin/python3", "python", installPython, "python")
export const ffmpegPath = resolver("ffmpeg/ffmpeg", "ffmpeg", installFfmpeg, "ffmpeg")

/** Used by `deno task vendor` to warm `vendor/` during the Deploy build. */
export async function vendorAll(): Promise<void> {
    if (!canVendor()) {
        console.log(
            `vendor: skipping on ${Deno.build.os}/${Deno.build.arch}; using python and ffmpeg from PATH`,
        )
        return
    }
    await installPython(`${BUILD_VENDOR}/python`)
    await installFfmpeg(`${BUILD_VENDOR}/ffmpeg`)
    console.log("vendor: done")
}
