import React, { useCallback, useEffect, useRef } from 'react';
import { getSharedEnvironmentCameraStream } from './camera-stream';

export interface AutoCameraCapturedImage {
  dataUrl: string;
  mimeType: string;
}

export type AutoCameraSearchStatus =
  | 'off'
  | 'starting'
  | 'watching'
  | 'motion'
  | 'stable'
  | 'analyzing'
  | 'cooldown'
  | 'error';

interface AutoCameraSearchProps {
  enabled: boolean;
  onCapture: (image: AutoCameraCapturedImage) => Promise<void>;
  onStatus?: (status: AutoCameraSearchStatus) => void;
  onError?: (message: string) => void;
}

const SAMPLE_WIDTH = 96;
const SAMPLE_HEIGHT = 54;
const SCAN_INTERVAL_MS = 250;
const STABLE_FRAME_COUNT = 5;
const BACKGROUND_STABLE_FRAME_COUNT = 8;
const MOTION_DIFF_THRESHOLD = 9;
const STABLE_DIFF_THRESHOLD = 4;
const OBJECT_DIFF_THRESHOLD = 10;
const CAPTURE_COOLDOWN_MS = 3500;

function averageFrameDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const length = Math.min(a.length, b.length);
  let total = 0;
  let pixels = 0;
  for (let i = 0; i < length; i += 4) {
    total += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    pixels += 1;
  }
  return pixels > 0 ? total / pixels : 0;
}

function frameSignature(frame: Uint8ClampedArray): string {
  let hash = 2166136261;
  for (let i = 0; i < frame.length; i += 64) {
    hash ^= frame[i];
    hash = Math.imul(hash, 16777619);
  }
  return String(hash >>> 0);
}

function readSampleFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): Uint8ClampedArray | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  return new Uint8ClampedArray(ctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data);
}

function captureCameraImage(video: HTMLVideoElement, canvas: HTMLCanvasElement): AutoCameraCapturedImage | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  const sourceWidth = video.videoWidth || 1280;
  const sourceHeight = video.videoHeight || 720;
  const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.88), mimeType: 'image/jpeg' };
}

export default function AutoCameraSearch({
  enabled,
  onCapture,
  onStatus,
  onError,
}: AutoCameraSearchProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const previousFrameRef = useRef<Uint8ClampedArray | null>(null);
  const backgroundFrameRef = useRef<Uint8ClampedArray | null>(null);
  const stableFramesRef = useRef(0);
  const backgroundStableFramesRef = useRef(0);
  const motionSeenRef = useRef(false);
  const analyzingRef = useRef(false);
  const cooldownUntilRef = useRef(0);
  const lastCaptureSignatureRef = useRef<string | null>(null);

  const setStatus = useCallback((status: AutoCameraSearchStatus) => {
    onStatus?.(status);
  }, [onStatus]);

  const resetDetector = useCallback(() => {
    previousFrameRef.current = null;
    backgroundFrameRef.current = null;
    stableFramesRef.current = 0;
    backgroundStableFramesRef.current = 0;
    motionSeenRef.current = false;
    analyzingRef.current = false;
    cooldownUntilRef.current = 0;
  }, []);

  const attachStream = useCallback(async () => {
    setStatus('starting');
    const stream = await getSharedEnvironmentCameraStream();
    const video = videoRef.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    await video.play().catch(() => undefined);
    setStatus('watching');
  }, [setStatus]);

  const inspectFrame = useCallback(async () => {
    const video = videoRef.current;
    const sampleCanvas = sampleCanvasRef.current;
    const captureCanvas = captureCanvasRef.current;
    if (!enabled || !video || !sampleCanvas || !captureCanvas || analyzingRef.current) return;

    const frame = readSampleFrame(video, sampleCanvas);
    if (!frame) return;

    const previous = previousFrameRef.current;
    previousFrameRef.current = frame;
    if (!previous) return;

    const diff = averageFrameDiff(frame, previous);
    const now = Date.now();
    if (now < cooldownUntilRef.current) {
      setStatus('cooldown');
      return;
    }

    if (diff >= MOTION_DIFF_THRESHOLD) {
      motionSeenRef.current = true;
      stableFramesRef.current = 0;
      backgroundStableFramesRef.current = 0;
      setStatus('motion');
      return;
    }

    if (!motionSeenRef.current) {
      if (diff <= STABLE_DIFF_THRESHOLD) {
        backgroundStableFramesRef.current += 1;
        if (backgroundStableFramesRef.current >= BACKGROUND_STABLE_FRAME_COUNT) {
          backgroundFrameRef.current = frame;
        }
      }
      setStatus('watching');
      return;
    }

    stableFramesRef.current = diff <= STABLE_DIFF_THRESHOLD ? stableFramesRef.current + 1 : 0;
    if (stableFramesRef.current < STABLE_FRAME_COUNT) {
      setStatus('stable');
      return;
    }

    motionSeenRef.current = false;
    stableFramesRef.current = 0;
    const objectDiff = backgroundFrameRef.current ? averageFrameDiff(frame, backgroundFrameRef.current) : OBJECT_DIFF_THRESHOLD + 1;
    if (objectDiff < OBJECT_DIFF_THRESHOLD) {
      backgroundFrameRef.current = frame;
      setStatus('watching');
      return;
    }

    const signature = frameSignature(frame);
    if (signature === lastCaptureSignatureRef.current) {
      cooldownUntilRef.current = now + CAPTURE_COOLDOWN_MS;
      setStatus('cooldown');
      return;
    }

    const image = captureCameraImage(video, captureCanvas);
    if (!image) return;

    analyzingRef.current = true;
    lastCaptureSignatureRef.current = signature;
    setStatus('analyzing');
    try {
      await onCapture(image);
      cooldownUntilRef.current = Date.now() + CAPTURE_COOLDOWN_MS;
      setStatus('cooldown');
    } catch (err: any) {
      onError?.(err?.message || 'Auto camera failed');
      cooldownUntilRef.current = Date.now() + CAPTURE_COOLDOWN_MS;
      setStatus('error');
    } finally {
      analyzingRef.current = false;
    }
  }, [enabled, onCapture, onError, setStatus]);

  useEffect(() => {
    if (!enabled) {
      resetDetector();
      setStatus('off');
      if (videoRef.current) videoRef.current.srcObject = null;
      return;
    }

    let cancelled = false;
    void attachStream().catch((err: any) => {
      if (!cancelled) {
        onError?.(err?.message || 'Camera unavailable');
        setStatus('error');
      }
    });
    const interval = window.setInterval(() => {
      void inspectFrame();
    }, SCAN_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [attachStream, enabled, inspectFrame, onError, resetDetector, setStatus]);

  return (
    <div className="pointer-events-none fixed -left-[9999px] top-0 h-px w-px overflow-hidden opacity-0" aria-hidden="true">
      <video ref={videoRef} muted playsInline className="h-px w-px" />
      <canvas ref={sampleCanvasRef} />
      <canvas ref={captureCanvasRef} />
    </div>
  );
}
