import React from 'react';
import LiveView from './LiveView';
import type { SecurityStatus } from '../../../shared/types';

interface CameraGridProps {
  status: SecurityStatus;
  mjpegPort: number;
  cameras: Array<{
    id: string;
    name: string;
    zone: 'outside' | 'inside';
  }>;
}

export default function CameraGrid({ status, mjpegPort, cameras }: CameraGridProps) {
  const count = cameras.length;

  // Dynamic grid: 1=1x1, 2=2x1, 3-4=2x2, 5-6=3x2
  const gridClass =
    count <= 1 ? 'grid-cols-1' :
    count <= 2 ? 'grid-cols-2' :
    count <= 4 ? 'grid-cols-2' :
    'grid-cols-3';

  return (
    <div className={`grid ${gridClass} gap-2`}>
      {cameras.map(cam => {
        const camStatus = status.cameras.find(c => c.id === cam.id);
        return (
          <LiveView
            key={cam.id}
            cameraId={cam.id}
            cameraName={cam.name}
            zone={cam.zone}
            connected={camStatus?.connected || false}
            fps={camStatus?.fps || 0}
            mjpegPort={mjpegPort}
          />
        );
      })}
      {cameras.length === 0 && (
        <div className="col-span-full flex items-center justify-center h-48 bg-slate-100 rounded-lg">
          <p className="text-sm text-slate-500">No cameras configured. Add cameras in Settings.</p>
        </div>
      )}
    </div>
  );
}
