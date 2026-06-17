import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { closeSync, constants, openSync } from "node:fs";
import {
  createAudioResource,
  StreamType,
  type AudioResource,
} from "@discordjs/voice";
import { config } from "./config.js";

/**
 * ffmpeg arguments to read go-librespot's raw PCM (s16le @ 44.1 kHz stereo) from
 * the FIFO and resample it to Discord's native 48 kHz stereo on stdout.
 */
export function buildFfmpegArgs(fifoPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    // Input: raw PCM from the named pipe.
    "-f", "s16le",
    "-ar", "44100",
    "-ac", "2",
    "-i", fifoPath,
    // Output: raw PCM at Discord's native 48 kHz stereo.
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
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

  /** Emitted whenever a fresh AudioResource is created (re)subscribe to it. */
  static readonly RESOURCE = "resource";

  start(): void {
    this.openKeepAlive();
    this.spawnFfmpeg();
  }

  /** Hold a non-blocking R/W fd so the pipe always has a writer present. */
  private openKeepAlive(): void {
    if (this.keepAliveFd !== null) return;
    this.keepAliveFd = openSync(
      config.librespot.fifoPath,
      constants.O_RDWR | constants.O_NONBLOCK,
    );
  }

  private spawnFfmpeg(): void {
    const proc = spawn("ffmpeg", buildFfmpegArgs(config.librespot.fifoPath), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.ffmpeg = proc;

    proc.stderr.on("data", (c: Buffer) => {
      const t = c.toString().trim();
      if (t) console.warn(`[ffmpeg] ${t}`);
    });

    proc.on("exit", (code) => {
      if (this.shuttingDown) return;
      console.warn(`[ffmpeg] exited (${code}); restarting bridge`);
      setTimeout(() => this.spawnFfmpeg(), 1000);
    });

    this.resource = createAudioResource(proc.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: false,
    });
    this.emit(AudioBridge.RESOURCE, this.resource);
  }

  getResource(): AudioResource | null {
    return this.resource;
  }

  stop(): void {
    this.shuttingDown = true;
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
