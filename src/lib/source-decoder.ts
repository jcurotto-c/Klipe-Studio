/**
 * Source video decoder for the MP4 export pipeline, built on Mediabunny.
 *
 * Why Mediabunny:
 *   The recorded source is a WebM blob produced by `MediaRecorder`. Chromium
 *   writes such files in "live streaming" form — chunks appended as they
 *   arrive, with the SeekHead/Cues element either missing or incomplete.
 *   That's a [documented MediaRecorder behavior](https://issues.chromium.org/issues/40643488)
 *   that breaks demuxers expecting metadata at the start of the file.
 *
 *   We previously tried `web-demuxer` (FFmpeg-WASM): it loaded the file but
 *   the underlying decoder rejected the chunks with the generic WebCodecs
 *   `EncodingError: Decoding error.` — the FFmpeg path doesn't auto-fix
 *   MediaRecorder's metadata layout.
 *
 *   Mediabunny is the actively-maintained successor to mp4-muxer (same
 *   author) and is what Remotion is migrating to specifically because it
 *   handles MediaRecorder's WebM layout transparently. It's pure TypeScript
 *   with zero dependencies, no WASM. `BlobSource` knows how to parse files
 *   whose metadata is at the end as well as the start.
 *
 *   The whole HTMLVideoElement / `requestVideoFrameCallback` /
 *   `drawImage(video)` machinery is gone. We get decoded frames straight
 *   out of `VideoSampleSink.samples()`, which exposes them as
 *   `VideoSample` wrappers around WebCodecs `VideoFrame`s.
 */

import {
  Input,
  BlobSource,
  ALL_FORMATS,
  VideoSampleSink,
  type InputVideoTrack,
} from 'mediabunny';

export interface SourceDecoderInitOptions {
  blob: Blob;
}

export type FrameHandler = (
  frame: VideoFrame,
  mediaTimeSec: number,
  durationSec: number,
) => void | Promise<void>;

/**
 * Wraps a Mediabunny Input + video track. One instance spans an entire export
 * (one demux of the source); a fresh VideoSampleSink is opened per fragment
 * so each fragment's iterator starts cleanly.
 */
export class SourceDecoder {
  private input: Input | null = null;
  private videoTrack: InputVideoTrack | null = null;

  async init({ blob }: SourceDecoderInitOptions): Promise<void> {
    this.input = new Input({
      source: new BlobSource(blob),
      formats: ALL_FORMATS,
    });
    const track = await this.input.getPrimaryVideoTrack();
    if (!track) throw new Error('Source has no video track');
    this.videoTrack = track;
    console.info(
      '[mp4-export] source video:',
      `${await track.getCodec()} ${await track.getCodedWidth()}x${await track.getCodedHeight()}`,
    );
  }

  /**
   * Decode every frame whose presentation timestamp falls inside
   * `[startSec, endSec)` and pass it to `onFrame`. Frames are delivered
   * serially in source order. Each callback receives a fresh `VideoFrame`
   * which the wrapper closes after the callback resolves.
   *
   * Mediabunny's `samples(start, end)` pre-decodes a few frames ahead for
   * fast iteration; back-pressure is applied automatically via the for-await
   * loop pacing.
   */
  async decodeRange(
    startSec: number,
    endSec: number,
    onFrame: FrameHandler,
  ): Promise<void> {
    if (!this.videoTrack) {
      throw new Error('SourceDecoder.init() was not awaited');
    }
    const sink = new VideoSampleSink(this.videoTrack);
    for await (const sample of sink.samples(startSec, endSec)) {
      // VideoSample.toVideoFrame() returns a fresh VideoFrame the caller is
      // responsible for closing. We pass it through to onFrame, then close
      // both wrapper and frame in the finally block.
      const videoFrame = sample.toVideoFrame();
      try {
        await onFrame(videoFrame, sample.timestamp, sample.duration);
      } finally {
        videoFrame.close();
        sample.close();
      }
    }
  }

  destroy(): void {
    if (this.input) {
      try { this.input.dispose(); } catch { /* ignore */ }
      this.input = null;
    }
    this.videoTrack = null;
  }
}
