"""
Process A: Stream Ingest

Thread per camera: reads RTSP substream via OpenCV, pushes latest
frame to a per-camera Queue (drop-oldest strategy).
Includes auto-reconnect with exponential backoff.
"""

import multiprocessing as mp
from multiprocessing import Queue, Event as MpEvent
import threading
import time
import sys
from typing import Dict, List, Any

import cv2
import numpy as np


class CameraReader(threading.Thread):
    """Reads frames from a single RTSP camera in a dedicated thread."""

    def __init__(
        self,
        camera_config: Dict[str, Any],
        frame_queue: Queue,
        preview_queue: 'Queue | None',
        shutdown_event: MpEvent,
    ):
        super().__init__(daemon=True)
        self.config = camera_config
        self.cam_id = camera_config['id']
        self.rtsp_url = camera_config.get('rtspSubstream', '')
        self.target_fps = camera_config.get('aiFps', 8)
        self.frame_queue = frame_queue
        self.preview_queue = preview_queue
        self.shutdown_event = shutdown_event

        self.connected = False
        self.fps = 0.0
        self.frame_count = 0
        self.reconnect_count = 0
        self.last_frame_time = 0.0
        self.queue_drops = 0

    def run(self):
        backoff = 1.0
        max_backoff = 30.0
        frame_interval = 1.0 / max(self.target_fps, 1)

        while not self.shutdown_event.is_set():
            cap = None
            try:
                cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
                if not cap.isOpened():
                    self._log(f'Failed to open RTSP: {self.rtsp_url}')
                    self.connected = False
                    time.sleep(min(backoff, max_backoff))
                    backoff = min(backoff * 2, max_backoff)
                    continue

                self.connected = True
                backoff = 1.0
                self.reconnect_count += 1
                self._log(f'Connected to {self.rtsp_url}')

                fps_counter = 0
                fps_start = time.time()

                while not self.shutdown_event.is_set():
                    ret, frame = cap.read()
                    if not ret:
                        self._log('Frame read failed, reconnecting...')
                        self.connected = False
                        break

                    now = time.time()

                    # Rate limiting: skip frames if reading faster than target
                    if now - self.last_frame_time < frame_interval * 0.8:
                        continue

                    self.last_frame_time = now
                    self.frame_count += 1
                    fps_counter += 1

                    # Calculate FPS every second
                    elapsed = now - fps_start
                    if elapsed >= 1.0:
                        self.fps = fps_counter / elapsed
                        fps_counter = 0
                        fps_start = now

                    # Push to queue (drop oldest if full)
                    frame_data = {
                        'camera_id': self.cam_id,
                        'frame': frame,
                        'timestamp': now,
                        'frame_number': self.frame_count,
                    }

                    if self.frame_queue.full():
                        try:
                            self.frame_queue.get_nowait()
                            self.queue_drops += 1
                        except Exception:
                            pass

                    try:
                        self.frame_queue.put_nowait(frame_data)
                    except Exception:
                        self.queue_drops += 1

                    # Also push to preview queue for MJPEG (drop oldest)
                    if self.preview_queue is not None:
                        if self.preview_queue.full():
                            try:
                                self.preview_queue.get_nowait()
                            except Exception:
                                pass
                        try:
                            self.preview_queue.put_nowait(frame_data)
                        except Exception:
                            pass

            except Exception as e:
                self._log(f'Error: {e}')
                self.connected = False
            finally:
                if cap is not None:
                    cap.release()

            if not self.shutdown_event.is_set():
                time.sleep(min(backoff, max_backoff))
                backoff = min(backoff * 2, max_backoff)

        self.connected = False
        self._log('Stopped')

    def _log(self, msg: str):
        try:
            print(f'[Ingest:{self.cam_id}] {msg}', file=sys.stderr, flush=True)
        except Exception:
            pass

    def get_status(self) -> Dict[str, Any]:
        return {
            'id': self.cam_id,
            'connected': self.connected,
            'fps': round(self.fps, 1),
            'frameCount': self.frame_count,
            'reconnectCount': self.reconnect_count,
            'queueDrops': self.queue_drops,
            'lastFrame': int(self.last_frame_time * 1000),
        }


class IngestProcess(mp.Process):
    """Manages multiple camera reader threads."""

    def __init__(
        self,
        cameras: List[Dict[str, Any]],
        frame_queues: Dict[str, Queue],
        preview_queues: Dict[str, Queue],
        shutdown_event: MpEvent,
    ):
        super().__init__(daemon=True)
        self.cameras = cameras
        self.frame_queues = frame_queues
        self.preview_queues = preview_queues
        self.shutdown_event = shutdown_event

    def run(self):
        readers: Dict[str, CameraReader] = {}

        for cam in self.cameras:
            cam_id = cam['id']
            if not cam.get('enabled', True) or not cam.get('aiEnabled', True):
                continue
            queue = self.frame_queues.get(cam_id)
            preview_queue = self.preview_queues.get(cam_id)
            if queue is None:
                continue

            reader = CameraReader(cam, queue, preview_queue, self.shutdown_event)
            reader.start()
            readers[cam_id] = reader

        print(f'[Ingest] Started {len(readers)} camera readers', file=sys.stderr, flush=True)

        # Wait for shutdown, restart dead readers
        while not self.shutdown_event.is_set():
            for cam_id, reader in list(readers.items()):
                if not reader.is_alive() and not self.shutdown_event.is_set():
                    print(
                        f'[Ingest] Reader {cam_id} died, restarting...',
                        file=sys.stderr,
                        flush=True,
                    )
                    cam = next((c for c in self.cameras if c['id'] == cam_id), None)
                    if cam:
                        queue = self.frame_queues.get(cam_id)
                        preview_queue = self.preview_queues.get(cam_id)
                        if queue:
                            new_reader = CameraReader(cam, queue, preview_queue, self.shutdown_event)
                            new_reader.start()
                            readers[cam_id] = new_reader
            self.shutdown_event.wait(timeout=5.0)

        print('[Ingest] Shutting down', file=sys.stderr, flush=True)
