import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { closeSync, constants, openSync } from "node:fs";
import {
  createAudioResource,
  StreamType,
  type AudioResource,
} from "@discordjs/voice";

/**
 * ffmpeg arguments to read go-librespot's raw PCM (s16le @ 44.1 kHz stereo) from
 * the FIFO and resample it to Discord's native 48 kHz stereo on stdout.
 */
export function buildFfmpegArgs(fifoPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    // Minimise latency: don't pre-buffer the input, skip stream analysis, use
    // unbuffered pipe I/O, and flush every output packet immediately. This keeps
    // the audio as close to real-time as the FIFO + resampler allow.
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-avioflags", "direct",
    "-analyzeduration", "0",
    "-probesize", "32",
    // Input: raw PCM from the named pipe.
    "-f", "s16le",
    "-ar", "44100",
    "-ac", "2",
    "-i", fifoPath,
    // Output: raw PCM at Discord's native 48 kHz stereo.
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "-flush_packets", "1",
    "pipe:1",
  ];
}

/**
 * Bridges go-librespot's raw PCM pipe into a Discord-playable audio resource.
 *
 * go-librespot writes interleaved s16le @ 44.1 kHz stereo. Discord voice wants
 * 48 kHz, so ffmpeg resamples in real time. We also hold our own read/write fd
 * open on the FIFO: that way, when Spotify pauses (go-librespot stops writing
 * and may close its end), ffmpeg never receives EOF and stays alive — playback
 * simply goes silent and resumes when audio flows again, with no process churn.
 */
export class AudioBridge extends EventEmitter {
  private ffmpeg: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private keepAliveFd: number | null = null;
  private resource: AudioResource | null = null;
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | null = null;
  /** Desired playback gain (0..1), applied inline so changes are near-instant. */
  private volume = 1;

  /** Emitted whenever a fresh AudioResource is created (re)subscribe to it. */
  static readonly RESOURCE = "resource";

  /**
   * @param fifoPath named pipe this bridge reads go-librespot's PCM from.
   * @param label short tag (e.g. slot index) used to disambiguate log lines.
   */
  constructor(
    private readonly fifoPath: string,
    private readonly label = "",
  ) {
    super();
  }

  start(): void {
    this.openKeepAlive();
    this.spawnFfmpeg();
  }

  /**
   * Set inline playback gain as a 0..1 fraction. Applied at the very end of the
   * pipeline (right before opus encoding), so a change takes effect on the next
   * ~20 ms frame instead of waiting for the FIFO + ffmpeg buffer to drain.
   */
  setVolume(fraction: number): void {
    this.volume = Math.max(0, Math.min(1, fraction));
    this.resource?.volume?.setVolume(this.volume);
  }

  /** Hold a non-blocking R/W fd so the pipe always has a writer present. */
  private openKeepAlive(): void {
    if (this.keepAliveFd !== null) return;
    this.keepAliveFd = openSync(
      this.fifoPath,
      constants.O_RDWR | constants.O_NONBLOCK,
    );
  }

  private spawnFfmpeg(): void {
    const proc = spawn("ffmpeg", buildFfmpegArgs(this.fifoPath), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.ffmpeg = proc;

    proc.stderr.on("data", (c: Buffer) => {
      const t = c.toString().trim();
      if (t) console.warn(`[ffmpeg${this.label}] ${t}`);
    });

    proc.on("exit", (code) => {
      if (this.shuttingDown) return;
      console.warn(`[ffmpeg${this.label}] exited (${code}); restarting bridge`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.shuttingDown) this.spawnFfmpeg();
      }, 1000);
    });

    const resource = createAudioResource(proc.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });
    // Carry the current gain onto each freshly spawned resource so volume
    // survives an ffmpeg restart.
    resource.volume?.setVolume(this.volume);
    this.resource = resource;
    this.emit(AudioBridge.RESOURCE, resource);
  }

  getResource(): AudioResource | null {
    return this.resource;
  }

  stop(): void {
    this.shuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.ffmpeg?.kill("SIGTERM");
    if (this.keepAliveFd !== null) {
      try {
        closeSync(this.keepAliveFd);
      } catch {
        /* ignore */
      }
      this.keepAliveFd = null;
    }
  }
}
