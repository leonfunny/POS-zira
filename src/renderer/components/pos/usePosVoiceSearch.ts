import { useCallback, useEffect, useRef, useState } from 'react';

export type PosVoiceStatus = 'idle' | 'ready' | 'listening' | 'transcribing' | 'error';

interface UsePosVoiceSearchOptions {
  enabled: boolean;
  canListen: () => boolean;
  onCommandText: (text: string) => void | Promise<void>;
  onError?: (message: string) => void;
}

const COMMAND_RECORD_MS = 3200;
const WAKE_RECORD_MS = 2600;
const WAKE_POLL_MS = 180;
const WAKE_COOLDOWN_MS = 9000;
const WAKE_FAILURE_BACKOFF_MS = 18000;
const WAKE_RMS_THRESHOLD = 0.06;
const WAKE_LOUD_FRAMES = 4;

function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime)) || '';
}

function recordFromStream(stream: MediaStream, durationMs: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof MediaRecorder === 'undefined') {
      reject(new Error('media-recorder-unavailable'));
      return;
    }

    const mimeType = pickRecorderMimeType();
    const chunks: Blob[] = [];
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    let timeoutId: number | null = null;

    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    recorder.onerror = () => {
      if (timeoutId != null) window.clearTimeout(timeoutId);
      reject(new Error('voice-recording-failed'));
    };
    recorder.onstop = () => {
      if (timeoutId != null) window.clearTimeout(timeoutId);
      resolve(new Blob(chunks, { type: mimeType || chunks[0]?.type || 'audio/webm' }));
    };

    recorder.start();
    timeoutId = window.setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, durationMs);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('voice-audio-read-failed'));
    reader.onloadend = () => {
      const value = String(reader.result || '');
      resolve(value.includes(',') ? value.split(',').pop() || '' : value);
    };
    reader.readAsDataURL(blob);
  });
}

function normalizeVoiceText(value: string): string {
  return value
    .replace(/[\u0110\u0111]/g, (ch) => (ch === '\u0110' ? 'D' : 'd'))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function editDistance(a: string, b: string): number {
  const rows = new Array<number>(b.length + 1).fill(0).map((_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = rows[0];
    rows[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = rows[j];
      rows[j] = Math.min(
        rows[j] + 1,
        rows[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = temp;
    }
  }
  return rows[b.length];
}

function isWakeWord(word: string): boolean {
  if (!word) return false;
  if (word === 'zira' || word === 'jira' || word === 'sira' || word === 'zila') return true;
  return word.length >= 3 && word.length <= 5 && editDistance(word, 'zira') <= 1;
}

function extractWakeQuery(text: string): string | null {
  const normalized = normalizeVoiceText(text);
  if (!normalized) return null;
  const words = normalized.split(/\s+/).filter(Boolean);
  const wakeIndex = words.findIndex(isWakeWord);
  if (wakeIndex < 0) return null;
  return words.slice(wakeIndex + 1).join(' ').trim();
}

export function usePosVoiceSearch({
  enabled,
  canListen,
  onCommandText,
  onError,
}: UsePosVoiceSearchOptions) {
  const [status, setStatus] = useState<PosVoiceStatus>('idle');
  const streamRef = useRef<MediaStream | null>(null);
  const commandCaptureInFlightRef = useRef(false);
  const wakeCaptureInFlightRef = useRef(false);
  const enabledRef = useRef(enabled);
  const canListenRef = useRef(canListen);
  const onCommandTextRef = useRef(onCommandText);
  const onErrorRef = useRef(onError);
  const nextWakeCaptureAtRef = useRef(0);

  enabledRef.current = enabled;
  canListenRef.current = canListen;
  onCommandTextRef.current = onCommandText;
  onErrorRef.current = onError;

  const ensureStream = useCallback(async (): Promise<MediaStream> => {
    if (streamRef.current?.active) return streamRef.current;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('microphone-unavailable');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    streamRef.current = stream;
    setStatus('ready');
    return stream;
  }, []);

  const runTranscription = useCallback(async (mode: 'command' | 'wake'): Promise<string | null> => {
    if (!enabledRef.current || !canListenRef.current()) return null;
    const stream = await ensureStream();
    if (mode === 'command') setStatus('listening');
    const blob = await recordFromStream(stream, mode === 'command' ? COMMAND_RECORD_MS : WAKE_RECORD_MS);
    if (!blob.size) return null;
    if (mode === 'command') setStatus('transcribing');
    const audioBase64 = await blobToBase64(blob);
    const result = await window.electronAPI.pos.voice.transcribe({
      audioBase64,
      mimeType: blob.type || 'audio/webm',
      model: mode === 'command' ? 'small' : 'tiny',
    });
    if (!result?.ok) throw new Error(result?.error || 'voice-transcribe-failed');
    return String(result.text || '').trim();
  }, [ensureStream]);

  const startCommandCapture = useCallback(async () => {
    if (commandCaptureInFlightRef.current) return;
    commandCaptureInFlightRef.current = true;
    nextWakeCaptureAtRef.current = Date.now() + WAKE_COOLDOWN_MS;
    try {
      const text = await runTranscription('command');
      if (text) {
        await onCommandTextRef.current(text);
      } else {
        onErrorRef.current?.('No voice detected');
      }
      setStatus('ready');
    } catch (err: any) {
      setStatus('error');
      onErrorRef.current?.(err?.message || 'Voice search failed');
      window.setTimeout(() => setStatus(streamRef.current?.active ? 'ready' : 'idle'), 1200);
    } finally {
      commandCaptureInFlightRef.current = false;
    }
  }, [runTranscription]);

  const runWakeCapture = useCallback(async () => {
    if (wakeCaptureInFlightRef.current || commandCaptureInFlightRef.current) return;
    wakeCaptureInFlightRef.current = true;
    nextWakeCaptureAtRef.current = Date.now() + WAKE_COOLDOWN_MS;
    try {
      const text = await runTranscription('wake');
      if (commandCaptureInFlightRef.current) return;
      const query = extractWakeQuery(text || '');
      if (query != null) {
        if (query) {
          await onCommandTextRef.current(query);
        } else {
          wakeCaptureInFlightRef.current = false;
          await startCommandCapture();
          return;
        }
      } else {
        nextWakeCaptureAtRef.current = Date.now() + WAKE_FAILURE_BACKOFF_MS;
      }
      if (!commandCaptureInFlightRef.current) setStatus(streamRef.current?.active ? 'ready' : 'idle');
    } catch {
      nextWakeCaptureAtRef.current = Date.now() + WAKE_FAILURE_BACKOFF_MS;
      if (!commandCaptureInFlightRef.current) setStatus(streamRef.current?.active ? 'ready' : 'idle');
    } finally {
      wakeCaptureInFlightRef.current = false;
    }
  }, [runTranscription, startCommandCapture]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timerId: number | null = null;
    let audioContext: AudioContext | null = null;
    let loudFrames = 0;

    const setup = async () => {
      const stream = await ensureStream();
      if (cancelled) return;
      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextCtor) return;
      audioContext = new AudioContextCtor();
      await audioContext.resume().catch(() => undefined);
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);

      const tick = () => {
        if (cancelled) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const centered = (samples[i] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / samples.length);
        loudFrames = rms >= WAKE_RMS_THRESHOLD ? loudFrames + 1 : 0;
        const now = Date.now();
        if (
          loudFrames >= WAKE_LOUD_FRAMES
          && now >= nextWakeCaptureAtRef.current
          && !wakeCaptureInFlightRef.current
          && !commandCaptureInFlightRef.current
          && enabledRef.current
          && canListenRef.current()
        ) {
          loudFrames = 0;
          nextWakeCaptureAtRef.current = now + WAKE_COOLDOWN_MS;
          void runWakeCapture();
        }
        timerId = window.setTimeout(tick, WAKE_POLL_MS);
      };
      tick();
    };

    setup().catch((err: any) => {
      setStatus('error');
      onErrorRef.current?.(err?.message || 'Microphone unavailable');
    });

    return () => {
      cancelled = true;
      if (timerId != null) window.clearTimeout(timerId);
      void audioContext?.close().catch(() => undefined);
    };
  }, [enabled, ensureStream, runWakeCapture]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  return {
    status,
    startCommandCapture,
    ensureReady: ensureStream,
  };
}
