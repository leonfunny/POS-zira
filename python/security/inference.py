"""
Process B: Inference Engine

Single inference loop that batches frames from all cameras and
runs YOLO detection. Splits detections back to per-camera queues.
"""

import multiprocessing as mp
from multiprocessing import Queue, Event as MpEvent
import time
import os
import sys
from typing import Dict, List, Any, Optional

import numpy as np


class InferenceProcess(mp.Process):
    """Batched YOLO inference across all camera frames."""

    def __init__(
        self,
        cameras: List[Dict[str, Any]],
        frame_queues: Dict[str, Queue],
        detection_queues: Dict[str, Queue],
        model_name: str,
        shutdown_event: MpEvent,
    ):
        super().__init__(daemon=True)
        self.cameras = cameras
        self.frame_queues = frame_queues
        self.detection_queues = detection_queues
        self.model_name = model_name
        self.shutdown_event = shutdown_event

    def run(self):
        # Import here so model loads in child process
        from ultralytics import YOLO

        self._log(f'Loading model: {self.model_name}')
        # Resolve model path: if it's a bare name like 'yolov8n', ultralytics
        # downloads/caches it automatically. If an absolute path is provided, use it.
        model_path = self.model_name
        if not os.path.isabs(model_path) and not model_path.endswith('.pt'):
            model_path = f'{model_path}.pt'
        model = YOLO(model_path)
        self._log('Model loaded')

        # Optional fire model (load if configured)
        fire_model: Optional[Any] = None

        camera_ids = [c['id'] for c in self.cameras if c.get('enabled', True) and c.get('aiEnabled', True)]
        max_batch = min(len(camera_ids), 8)

        inference_count = 0
        fps_start = time.time()
        total_fps = 0.0

        while not self.shutdown_event.is_set():
            batch_frames = []
            batch_cam_ids = []

            # Collect latest frame from each camera
            for cam_id in camera_ids:
                queue = self.frame_queues.get(cam_id)
                if queue is None or queue.empty():
                    continue

                frame_data = None
                # Drain to latest
                while not queue.empty():
                    try:
                        frame_data = queue.get_nowait()
                    except Exception:
                        break

                if frame_data is not None:
                    batch_frames.append(frame_data['frame'])
                    batch_cam_ids.append(cam_id)

                if len(batch_frames) >= max_batch:
                    break

            if not batch_frames:
                time.sleep(0.01)
                continue

            try:
                # Run batched inference
                results = model.predict(
                    source=batch_frames,
                    conf=0.45,
                    verbose=False,
                    stream=False,
                )

                # Split results per camera
                for i, (cam_id, result) in enumerate(zip(batch_cam_ids, results)):
                    detections = []
                    if result.boxes is not None:
                        for box in result.boxes:
                            detections.append({
                                'class_id': int(box.cls[0]),
                                'class_name': result.names[int(box.cls[0])],
                                'confidence': float(box.conf[0]),
                                'bbox': box.xywhn[0].tolist(),  # normalized x,y,w,h
                                'bbox_xyxy': box.xyxy[0].tolist(),  # pixel coords
                            })

                    det_queue = self.detection_queues.get(cam_id)
                    if det_queue is not None:
                        det_data = {
                            'camera_id': cam_id,
                            'detections': detections,
                            'timestamp': time.time(),
                            'frame_shape': batch_frames[i].shape[:2],
                        }
                        if det_queue.full():
                            try:
                                det_queue.get_nowait()
                            except Exception:
                                pass
                        try:
                            det_queue.put_nowait(det_data)
                        except Exception:
                            pass

                inference_count += len(batch_frames)

                # FPS calculation
                now = time.time()
                elapsed = now - fps_start
                if elapsed >= 2.0:
                    total_fps = inference_count / elapsed
                    inference_count = 0
                    fps_start = now

            except Exception as e:
                self._log(f'Inference error: {e}')
                time.sleep(0.1)

        self._log('Shutting down')

    def _log(self, msg: str):
        try:
            print(f'[Inference] {msg}', file=sys.stderr, flush=True)
        except Exception:
            pass
