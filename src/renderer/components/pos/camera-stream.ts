let sharedCameraStream: MediaStream | null = null;
let sharedCameraStartPromise: Promise<MediaStream> | null = null;

function isLiveStream(stream: MediaStream | null): stream is MediaStream {
  return stream?.getVideoTracks().some((track) => track.readyState === 'live') ?? false;
}

export function getLiveSharedCameraStream(): MediaStream | null {
  return isLiveStream(sharedCameraStream) ? sharedCameraStream : null;
}

export async function getSharedEnvironmentCameraStream(): Promise<MediaStream> {
  const live = getLiveSharedCameraStream();
  if (live) return live;
  if (sharedCameraStartPromise) return sharedCameraStartPromise;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera unavailable');
  }

  sharedCameraStartPromise = navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  }).then((stream) => {
    sharedCameraStream = stream;
    stream.getTracks().forEach((track) => {
      track.onended = () => {
        if (sharedCameraStream === stream) sharedCameraStream = null;
      };
    });
    return stream;
  }).finally(() => {
    sharedCameraStartPromise = null;
  });

  return sharedCameraStartPromise;
}

export function releaseSharedEnvironmentCameraStream(): void {
  sharedCameraStream?.getTracks().forEach((track) => track.stop());
  sharedCameraStream = null;
  sharedCameraStartPromise = null;
}
