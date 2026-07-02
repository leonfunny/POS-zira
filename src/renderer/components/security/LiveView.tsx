import React from 'react';

interface LiveViewProps {
  cameraId: string;
  cameraName: string;
  zone: 'outside' | 'inside';
  connected: boolean;
  fps: number;
  mjpegPort: number;
}

export default function LiveView({ cameraId, cameraName, zone, connected, fps, mjpegPort }: LiveViewProps) {
  const streamUrl = `http://localhost:${mjpegPort}/cam/${cameraId}`;

  return (
    <div className="relative bg-slate-900 rounded-lg overflow-hidden aspect-video">
      {connected ? (
        <img
          src={streamUrl}
          alt={cameraName}
          className="w-full h-full object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-slate-500 text-sm">No Signal</div>
        </div>
      )}

      {/* Status overlay */}
      <div className="absolute top-2 left-2 right-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
          <span className="text-xs text-white font-medium bg-black/50 px-1.5 py-0.5 rounded">
            {cameraName}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-white/70 bg-black/50 px-1.5 py-0.5 rounded uppercase">
            {zone}
          </span>
          {connected && (
            <span className="text-[10px] text-emerald-400 bg-black/50 px-1.5 py-0.5 rounded">
              {fps} FPS
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
