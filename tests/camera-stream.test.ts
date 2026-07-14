import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLiveSharedCameraStream,
  getSharedEnvironmentCameraStream,
  releaseSharedEnvironmentCameraStream,
} from '../src/renderer/components/pos/camera-stream';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cameraStream(name: string) {
  const track = {
    name,
    readyState: 'live',
    onended: null as (() => void) | null,
    stop: vi.fn(() => {
      track.readyState = 'ended';
      track.onended?.();
    }),
  };
  const stream = {
    name,
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

describe('shared camera generation ownership', () => {
  beforeEach(() => {
    releaseSharedEnvironmentCameraStream();
  });

  afterEach(() => {
    releaseSharedEnvironmentCameraStream();
    vi.unstubAllGlobals();
  });

  it('stops a canceled late stream instead of replacing the reopened live stream', async () => {
    const first = deferred<MediaStream>();
    const second = deferred<MediaStream>();
    const getUserMedia = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const oldCamera = cameraStream('old');
    const reopenedCamera = cameraStream('reopened');

    const canceledRequest = getSharedEnvironmentCameraStream();
    releaseSharedEnvironmentCameraStream();
    const reopenedRequest = getSharedEnvironmentCameraStream();

    second.resolve(reopenedCamera.stream);
    await expect(reopenedRequest).resolves.toBe(reopenedCamera.stream);
    first.resolve(oldCamera.stream);
    await expect(canceledRequest).rejects.toThrow(/superseded/i);

    expect(oldCamera.track.stop).toHaveBeenCalledTimes(1);
    expect(reopenedCamera.track.stop).not.toHaveBeenCalled();
    expect(getLiveSharedCameraStream()).toBe(reopenedCamera.stream);
  });

  it('does not let a canceled request clear the newer pending request', async () => {
    const first = deferred<MediaStream>();
    const second = deferred<MediaStream>();
    const getUserMedia = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const oldCamera = cameraStream('old');
    const reopenedCamera = cameraStream('reopened');

    const canceledRequest = getSharedEnvironmentCameraStream();
    releaseSharedEnvironmentCameraStream();
    const reopenedRequest = getSharedEnvironmentCameraStream();

    first.resolve(oldCamera.stream);
    await expect(canceledRequest).rejects.toThrow(/superseded/i);
    const sharedPendingRequest = getSharedEnvironmentCameraStream();
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    second.resolve(reopenedCamera.stream);
    await expect(reopenedRequest).resolves.toBe(reopenedCamera.stream);
    await expect(sharedPendingRequest).resolves.toBe(reopenedCamera.stream);
    expect(oldCamera.track.stop).toHaveBeenCalledTimes(1);
  });
});
