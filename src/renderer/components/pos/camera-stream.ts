let sharedCameraStream: MediaStream | null = null;
let sharedCameraStartPromise: Promise<MediaStream> | null = null;
let sharedCameraGeneration = 0;
let sharedCameraStartGeneration: number | null = null;

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

  const generation = ++sharedCameraGeneration;
  sharedCameraStartGeneration = generation;
  sharedCameraStartPromise = navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  }).then((stream) => {
    if (generation !== sharedCameraGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Camera request superseded');
    }
    sharedCameraStream = stream;
    stream.getTracks().forEach((track) => {
      track.onended = () => {
        if (sharedCameraStream === stream) sharedCameraStream = null;
      };
    });
    return stream;
  }).finally(() => {
    if (sharedCameraStartGeneration === generation) {
      sharedCameraStartPromise = null;
      sharedCameraStartGeneration = null;
    }
  });

  return sharedCameraStartPromise;
}

export function releaseSharedEnvironmentCameraStream(): void {
  sharedCameraGeneration++;
  sharedCameraStream?.getTracks().forEach((track) => track.stop());
  sharedCameraStream = null;
  sharedCameraStartPromise = null;
  sharedCameraStartGeneration = null;
}
