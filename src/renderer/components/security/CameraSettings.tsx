import React, { useState, useEffect } from 'react';
import type { CameraConfig, CameraZone, CameraAlgorithm } from '../../../shared/types';

interface CameraSettingsProps {
  cameras: CameraConfig[];
  onSave: (cameras: CameraConfig[]) => void;
}

const OUTSIDE_ALGORITHMS: { key: CameraAlgorithm; label: string }[] = [
  { key: 'loitering', label: 'Loitering Detection' },
  { key: 'recording', label: 'Suspicious Recording' },
];

const INSIDE_ALGORITHMS: { key: CameraAlgorithm; label: string }[] = [
  { key: 'theft', label: 'Anti-Theft / Intrusion' },
  { key: 'fire', label: 'Fire & Smoke' },
  { key: 'analytics_flow', label: 'Customer Flow' },
  { key: 'analytics_staff', label: 'Staff Analytics' },
];

function generateId(): string {
  return `cam_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const defaultCamera: Omit<CameraConfig, 'id'> = {
  name: '',
  zone: 'outside',
  enabled: true,
  rtspSubstream: '',
  aiEnabled: true,
  aiFps: 8,
  algorithms: [],
  confidenceThreshold: 0.45,
  zones: [],
  loiterDwellSeconds: 30,
  loiterReturnWindow: 10,
  loiterReturnCount: 3,
  firePersistSeconds: 3,
  theftDwellSeconds: 15,
  scheduleEnabled: false,
  scheduleStart: '00:00',
  scheduleEnd: '23:59',
  scheduleDays: [0, 1, 2, 3, 4, 5, 6],
};

export default function CameraSettings({ cameras, onSave }: CameraSettingsProps) {
  const [editCameras, setEditCameras] = useState<CameraConfig[]>(cameras);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Sync with parent when cameras prop changes (e.g., after save)
  useEffect(() => {
    setEditCameras(cameras);
  }, [cameras]);

  const addCamera = () => {
    const newCam: CameraConfig = { ...defaultCamera, id: generateId(), name: `Camera ${editCameras.length + 1}` };
    setEditCameras([...editCameras, newCam]);
    setExpandedId(newCam.id);
  };

  const removeCamera = (id: string) => {
    setEditCameras(editCameras.filter(c => c.id !== id));
  };

  const updateCamera = (id: string, updates: Partial<CameraConfig>) => {
    setEditCameras(editCameras.map(c => c.id === id ? { ...c, ...updates } : c));
  };

  const handleSave = () => {
    onSave(editCameras);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">
          Cameras ({editCameras.length})
        </h3>
        <div className="flex gap-2">
          <button
            onClick={addCamera}
            className="px-3 py-1.5 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors"
          >
            + Add Camera
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            Save All
          </button>
        </div>
      </div>

      {editCameras.length === 0 ? (
        <div className="text-sm text-slate-400 p-6 text-center bg-slate-50 rounded-lg">
          No cameras configured. Click "Add Camera" to get started.
        </div>
      ) : (
        <div className="space-y-2">
          {editCameras.map((cam) => {
            const isExpanded = expandedId === cam.id;
            const algos = cam.zone === 'outside' ? OUTSIDE_ALGORITHMS : INSIDE_ALGORITHMS;

            return (
              <div key={cam.id} className="border border-slate-200 rounded-lg overflow-hidden">
                {/* Header */}
                <div
                  className="flex items-center justify-between p-3 bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : cam.id)}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${cam.enabled ? 'bg-green-500' : 'bg-slate-300'}`} />
                    <span className="text-sm font-medium text-slate-700">{cam.name || 'Unnamed'}</span>
                    <span className="text-[10px] text-slate-400 uppercase bg-slate-200 px-1.5 py-0.5 rounded">{cam.zone}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">{cam.algorithms.length} algos</span>
                    <span className="text-slate-400">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {/* Expanded form */}
                {isExpanded && (
                  <div className="p-3 space-y-3 border-t border-slate-200">
                    {/* Name + Zone */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-slate-500 block mb-1">Name</label>
                        <input
                          type="text"
                          value={cam.name}
                          onChange={(e) => updateCamera(cam.id, { name: e.target.value })}
                          className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                          placeholder="Front Door"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-slate-500 block mb-1">Zone</label>
                        <select
                          value={cam.zone}
                          onChange={(e) => updateCamera(cam.id, { zone: e.target.value as CameraZone, algorithms: [] })}
                          className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                        >
                          <option value="outside">Outside (Perimeter)</option>
                          <option value="inside">Inside (Safety + Analytics)</option>
                        </select>
                      </div>
                    </div>

                    {/* RTSP URLs */}
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">RTSP Substream (AI)</label>
                      <input
                        type="text"
                        value={cam.rtspSubstream}
                        onChange={(e) => updateCamera(cam.id, { rtspSubstream: e.target.value })}
                        className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 font-mono"
                        placeholder="rtsp://admin:pass@192.168.1.100:554/stream1"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">RTSP Mainstream (Evidence, optional)</label>
                      <input
                        type="text"
                        value={cam.rtspMainstream || ''}
                        onChange={(e) => updateCamera(cam.id, { rtspMainstream: e.target.value })}
                        className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 font-mono"
                        placeholder="rtsp://admin:pass@192.168.1.100:554/stream0"
                      />
                    </div>

                    {/* AI Settings */}
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="text-xs text-slate-500 block mb-1">AI FPS</label>
                        <input
                          type="number"
                          value={cam.aiFps}
                          onChange={(e) => updateCamera(cam.id, { aiFps: Number(e.target.value) })}
                          className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                          min={1} max={30}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-slate-500 block mb-1">Confidence</label>
                        <input
                          type="number"
                          value={cam.confidenceThreshold}
                          onChange={(e) => updateCamera(cam.id, { confidenceThreshold: Number(e.target.value) })}
                          className="w-full text-sm border border-slate-200 rounded px-2 py-1.5"
                          min={0.1} max={1} step={0.05}
                        />
                      </div>
                      <div className="flex items-end gap-2 pb-1">
                        <label className="flex items-center gap-1.5 text-xs">
                          <input
                            type="checkbox"
                            checked={cam.enabled}
                            onChange={(e) => updateCamera(cam.id, { enabled: e.target.checked })}
                          />
                          Enabled
                        </label>
                        <label className="flex items-center gap-1.5 text-xs">
                          <input
                            type="checkbox"
                            checked={cam.aiEnabled}
                            onChange={(e) => updateCamera(cam.id, { aiEnabled: e.target.checked })}
                          />
                          AI On
                        </label>
                      </div>
                    </div>

                    {/* Algorithms */}
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">Algorithms</label>
                      <div className="flex flex-wrap gap-2">
                        {algos.map(algo => (
                          <label key={algo.key} className="flex items-center gap-1.5 text-xs bg-slate-50 px-2 py-1 rounded">
                            <input
                              type="checkbox"
                              checked={cam.algorithms.includes(algo.key)}
                              onChange={(e) => {
                                const algs = e.target.checked
                                  ? [...cam.algorithms, algo.key]
                                  : cam.algorithms.filter(a => a !== algo.key);
                                updateCamera(cam.id, { algorithms: algs });
                              }}
                            />
                            {algo.label}
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Delete */}
                    <div className="pt-2 border-t border-slate-100">
                      <button
                        onClick={() => removeCamera(cam.id)}
                        className="text-xs text-red-500 hover:text-red-700 transition-colors"
                      >
                        Remove Camera
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
