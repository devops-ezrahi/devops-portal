import { execFile, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * npm is `npm.cmd` on Windows, and Node 20.12+ refuses to spawn a bare `.cmd`
 * without a shell (CVE-2024-27980). Prod is Linux, but dev here is not always.
 */
export const useShell = process.platform === "win32";

/**
 * Even non-routine output is capped: the log is persisted and re-polled.
 */
const MAX_LOG_LINES = 300;
const HEARTBEAT_MS = 15_000;

/** CSI and OSC sequences — colour, cursor moves, the line-erase a redrawn progress bar uses. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[a-zA-Z]|\u001b\][^\u0007]*\u0007/g;

/**
 * One dependency-resolver subprocess, streaming its output into the job log as
 * it arrives.
 *
 * spawn, not execFileAsync: a resolve runs for minutes and execFile buffers
 * until exit, so the job drawer would sit blank for the whole thing and only
 * fill in once it was already over. Same reason RealAiApi spawns opencode.
 *
 * Extracted from what used to be `runNpmInstall`: npm, maven and pip all want
 * the same line buffering, the same log cap, the same heartbeat and the same
 * three failure shapes, and three copies of that is three places to fix a
 * swallowed Stop.
 */
export function runTool(opts: {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Lines matching this are counted rather than mirrored — per-request progress
   * chatter, which is what makes the heartbeat below able to report real
   * movement without burying the lines that actually diagnose a failure.
   */
  quietRe?: RegExp;
  /** What the heartbeat calls the counted lines, e.g. "registry request". */
  quietNoun?: string;
  timeoutMs: number;
  onLog: (line: string) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { bin, args, cwd, env, quietRe, quietNoun = "line", timeoutMs, onLog, signal } = opts;

  // Tokens live in the config files each caller writes, never in argv — this
  // line is echoed into a persisted log.
  onLog(`$ ${bin} ${args.join(" ")}`);

  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, deadline]);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      signal: combined,
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
    });

    let mirrored = 0;
    let suppressed = 0;
    let quiet = 0;
    let tail = "";
    const started = Date.now();

    const handleLine = (raw: string) => {
      // Stripped here rather than per caller: pip draws progress bars, maven
      // colours its warnings, and this log is persisted and re-rendered as
      // plain text, where an escape sequence is just noise around the message.
      const line = raw.replace(ANSI_RE, "");
      if (!line.trim()) return;
      if (quietRe?.test(line)) {
        quiet++;
        return;
      }
      if (mirrored < MAX_LOG_LINES) {
        mirrored++;
        onLog(line.trimEnd());
      } else {
        suppressed++;
      }
    };

    // npm writes almost everything — including plain progress — to stderr, and
    // maven splits itself across both, so the two streams share one buffer.
    const onChunk = (chunk: Buffer) => {
      tail += chunk.toString();
      const parts = tail.split("\n");
      tail = parts.pop() ?? "";
      for (const part of parts) handleLine(part);
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    // The only sign of life during a long resolve, now that the per-request
    // lines are counted instead of mirrored.
    const heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - started) / 1000);
      onLog(`${bin} still running (${seconds}s, ${quiet} ${quietNoun}(s))`);
    }, HEARTBEAT_MS);

    const settle = () => {
      clearInterval(heartbeat);
      if (tail.trim()) handleLine(tail);
      if (suppressed > 0) onLog(`(${suppressed} further ${bin} line(s) suppressed)`);
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      settle();
      if (err.code === "ENOENT") {
        reject(new Error(`${bin} not found — ensure it is on PATH`));
        return;
      }
      // Our own deadline becomes a message; the user's Stop stays an AbortError
      // so RealArtifactoryApi can tell the two apart and keep a Stop a Stop.
      if (deadline.aborted && !signal.aborted) {
        reject(new Error(`${bin} exceeded ${Math.round(timeoutMs / 60000)} minutes`));
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      settle();
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited with code ${code}`));
    });
  });
}

/**
 * `bin`'s version string, or `null` when it is not installed.
 *
 * The three resolvers are all optional: the image may or may not carry maven and
 * pip, and a dev box usually carries neither. A missing tool has to read as
 * "copying the single artifact" in the job log, not as a failed job — so this is
 * a probe, and every failure mode collapses to `null`.
 */
export async function toolVersion(bin: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { shell: useShell });
    return (stdout || stderr).trim().split("\n")[0] ?? "";
  } catch {
    return null;
  }
}
