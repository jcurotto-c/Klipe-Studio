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
  type VideoSample,
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

/**
 * Time-indexed reader for the SEPARATE webcam track, used by the export
 * pipeline to composite the camera disc onto each output frame.
 *
 * The camera was recorded simultaneously with the screen (both start at t=0,
 * shared source clock — see EditorView's camera sync), so for a screen frame
 * at source-time `t` we want the camera frame whose presentation interval
 * contains `t`. We pull frames from a single forward iterator and keep the
 * last one whose timestamp is <= the requested time, so each camera packet is
 * decoded at most once for the common case of monotonically increasing `t`.
 * If `t` jumps backwards (fragments out of source order) we transparently
 * re-open the iterator from the new position.
 */
export class CameraFrameProvider {
  private input: Input | null = null;
  private track: InputVideoTrack | null = null;
  private iter: AsyncIterator<VideoSample> | null = null;
  /** Sample whose interval currently covers the requested time. */
  private current: VideoSample | null = null;
  /** Lazily-materialized VideoFrame for `current` (provider-owned). */
  private currentFrame: VideoFrame | null = null;
  /** One-frame look-ahead: the next sample, not yet consumed. */
  private peeked: VideoSample | null = null;
  private lastTime = -Infinity;

  /** Returns false if the blob has no decodable video track (camera dropped). */
  async init(blob: Blob): Promise<boolean> {
    this.input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await this.input.getPrimaryVideoTrack();
    if (!track) return false;
    this.track = track;
    await this.openFrom(0);
    return true;
  }

  private async openFrom(startSec: number): Promise<void> {
    // Release the previous iterator + any held samples before reseeking.
    try { await this.iter?.return?.(); } catch { /* ignore */ }
    this.current?.close();
    this.current = null;
    this.currentFrame?.close();
    this.currentFrame = null;
    this.peeked?.close();
    this.peeked = null;
    // Fresh sink per (re)seek so we never run two iterators over one sink.
    const sink = new VideoSampleSink(this.track!);
    this.iter = sink.samples(Math.max(0, startSec))[Symbol.asyncIterator]();
    const first = await this.iter.next();
    this.peeked = first.done ? null : first.value;
  }

  /**
   * Returns the camera VideoFrame to draw at `tSec`, or null if no frame
   * applies yet. The returned frame is OWNED by the provider and stays valid
   * only until the next `frameAt`/`destroy` — the caller must draw it
   * synchronously and must NOT close it.
   */
  async frameAt(tSec: number): Promise<VideoFrame | null> {
    if (!this.track || !this.iter) return null;
    if (tSec < this.lastTime - 1e-3) {
      // Rewound (fragments out of source order): reopen a touch earlier so the
      // frame that covers tSec is included, then let the loop below land on it.
      await this.openFrom(Math.max(0, tSec - 0.5));
    }
    this.lastTime = tSec;

    // Advance while the look-ahead frame starts at or before the requested
    // time; the last one consumed is the frame that covers `tSec`.
    while (this.peeked && this.peeked.timestamp <= tSec) {
      this.current?.close();
      this.currentFrame?.close();
      this.currentFrame = null;
      this.current = this.peeked;
      const next = await this.iter.next();
      this.peeked = next.done ? null : next.value;
    }

    if (!this.current) return null;
    if (!this.currentFrame) this.currentFrame = this.current.toVideoFrame();
    return this.currentFrame;
  }

  destroy(): void {
    try { void this.iter?.return?.(); } catch { /* ignore */ }
    this.iter = null;
    this.current?.close();
    this.current = null;
    this.currentFrame?.close();
    this.currentFrame = null;
    this.peeked?.close();
    this.peeked = null;
    if (this.input) {
      try { this.input.dispose(); } catch { /* ignore */ }
      this.input = null;
    }
    this.track = null;
  }
}
