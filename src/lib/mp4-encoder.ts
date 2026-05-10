/**
 * Format-agnostic export encoder built on Mediabunny.
 *
 * Both the MP4 and WebM export paths share this pipeline: we demux source
 * frames via Mediabunny's `Input`, render with effects onto a 2D canvas,
 * then push canvas snapshots through `CanvasSource` (which wraps a
 * hardware-accelerated WebCodecs `VideoEncoder` and a muxer for the chosen
 * container). Audio is mixed offline into an `AudioBuffer` and fed in one
 * shot through `AudioBufferSource`.
 *
 * Container/codec selection:
 *   - `'mp4'`:  Mp4OutputFormat (faststart) + AVC video + AAC audio.
 *   - `'webm'`: WebMOutputFormat + VP9 video + Opus audio.
 *
 * Why Mediabunny instead of bare WebCodecs:
 *   - CanvasSource.add(timestamp, duration) handles VideoFrame creation,
 *     encoder back-pressure, and submission ordering. Submissions can't race
 *     past each other (the bug that produced non-monotonic DTS in our
 *     hand-rolled wrapper).
 *   - AudioBufferSource.add(audioBuffer) takes a Web Audio AudioBuffer
 *     directly (which is what OfflineAudioContext returns) and encodes to
 *     AAC/Opus internally — no manual chunking or PCM marshaling.
 *   - The MP4 muxer uses `fastStart: 'in-memory'` so moov sits at the front
 *     of the file (streamable from byte 0). WebM's Matroska container is
 *     streamable by design, so no equivalent option is needed there.
 */

import {
  Output,
  Mp4OutputFormat,
  WebMOutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
} from 'mediabunny';

export type ExportContainerFormat = 'mp4' | 'webm';

export interface Mp4EncoderConfig {
  /** Container/codec selection. */
  format: ExportContainerFormat;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  hasAudio: boolean;
  audioSampleRate?: number;
  audioChannels?: number;
  audioBitrate?: number;
  /** Canvas to encode frames from. Each call to addFrame() snapshots its current state. */
  canvas: HTMLCanvasElement;
}

export interface Mp4EncoderHandle {
  /**
   * Captures the current canvas state as one frame and pushes it into the
   * encoder. Awaiting the returned promise applies encoder back-pressure.
   */
  addFrame(timestampSec: number, durationSec: number): Promise<void>;
  /** Encodes and adds an AudioBuffer to the audio track. */
  addAudio(buffer: AudioBuffer): Promise<void>;
  /** Finalizes the file and returns the byte buffer. */
  finalize(): Promise<Uint8Array>;
  /** Cancels the export, releasing internal encoder resources. */
  abort(): Promise<void>;
}

export function isMp4ExportSupported(): boolean {
  if (typeof VideoEncoder === 'undefined') return false;
  return true;
}

const KEYFRAME_INTERVAL_SEC = 2;

export async function createMp4Encoder(
  config: Mp4EncoderConfig,
): Promise<Mp4EncoderHandle> {
  if (!isMp4ExportSupported()) {
    throw new Error('WebCodecs is not available in this build; cannot export video.');
  }

  const isMp4 = config.format === 'mp4';

  const output = new Output({
    format: isMp4
      // Rewrites moov to the front so the file is streamable from byte 0.
      ? new Mp4OutputFormat({ fastStart: 'in-memory' })
      // Matroska/WebM is intrinsically streamable; no faststart equivalent.
      : new WebMOutputFormat(),
    target: new BufferTarget(),
  });

  const videoSource = new CanvasSource(config.canvas, {
    codec: isMp4 ? 'avc' : 'vp9',
    bitrate: config.videoBitrate,
    keyFrameInterval: KEYFRAME_INTERVAL_SEC,
  });
  // No `frameRate` metadata: screen recordings are variable-framerate and we
  // pass each frame's true source timestamp to addFrame(). Declaring a fixed
  // frameRate would snap our timestamps to that grid and either drop frames
  // (collisions) or stretch the timeline. We let Mediabunny carry the
  // source's real pacing through to the output instead.
  output.addVideoTrack(videoSource);

  let audioSource: AudioBufferSource | null = null;
  if (config.hasAudio) {
    audioSource = new AudioBufferSource({
      codec: isMp4 ? 'aac' : 'opus',
      bitrate: config.audioBitrate ?? 192_000,
    });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  return {
    async addFrame(timestampSec, durationSec) {
      // The await on this promise is what applies back-pressure to the
      // encoder. Mediabunny serializes encoder submissions internally, so we
      // can never accidentally race past `encode()` like the previous
      // hand-rolled pipeline did.
      await videoSource.add(timestampSec, durationSec);
    },
    async addAudio(buffer) {
      if (!audioSource) return;
      await audioSource.add(buffer);
    },
    async finalize() {
      await output.finalize();
      const buffer = output.target.buffer;
      if (!buffer) throw new Error('Mediabunny finalized without producing a buffer');
      return new Uint8Array(buffer);
    },
    async abort() {
      try { await output.cancel(); } catch { /* ignore */ }
    },
  };
}
