"""
Process D: Evidence & Notification

- Snapshot writer: saves annotated JPEG on alert
- Clip writer: extracts ring buffer → MP4 via ffmpeg
- MJPEG HTTP server: serves live preview per camera
"""

import multiprocessing as mp
from multiprocessing import Queue, Event as MpEvent
import threading
import time
import sys
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from typing import Dict, List, Any, Optional

import cv2
import numpy as np


class MJPEGHandler(BaseHTTPRequestHandler):
    """Serves MJPEG stream for a specific camera."""

    # Class-level shared state (set by EvidenceProcess)
    latest_frames: Dict[str, bytes] = {}
    camera_ids: List[str] = []
    frame_lock: threading.Lock = threading.Lock()

    def do_GET(self):
        # URL: /cam/{camera_id}
        path = self.path.strip('/')
        parts = path.split('/')

        if len(parts) == 2 and parts[0] == 'cam':
            cam_id = parts[1]
            if cam_id not in self.camera_ids:
                self.send_error(404, f'Camera {cam_id} not found')
                return
            self._stream_mjpeg(cam_id)
        elif path == '' or path == 'status':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            import json
            self.wfile.write(json.dumps({
                'cameras': self.camera_ids,
                'active': len(self.latest_frames),
            }).encode())
        else:
            self.send_error(404)

    def _stream_mjpeg(self, cam_id: str):
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()

        try:
            while True:
                with self.frame_lock:
                    jpeg = self.latest_frames.get(cam_id)
                if jpeg:
                    self.wfile.write(b'--frame\r\n')
                    self.wfile.write(b'Content-Type: image/jpeg\r\n')
                    self.wfile.write(f'Content-Length: {len(jpeg)}\r\n'.encode())
                    self.wfile.write(b'\r\n')
                    self.wfile.write(jpeg)
                    self.wfile.write(b'\r\n')
                time.sleep(0.1)  # ~10fps preview
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, format, *args):
        # Suppress HTTP server logs
        pass


class EvidenceProcess(mp.Process):
    """Manages evidence recording and MJPEG preview server."""

    def __init__(
        self,
        cameras: List[Dict[str, Any]],
        preview_queues: Dict[str, Queue],
        evidence_queue: Queue,
        mjpeg_port: int,
        shutdown_event: MpEvent,
    ):
        super().__init__(daemon=True)
        self.cameras = cameras
        self.preview_queues = preview_queues
        self.evidence_queue = evidence_queue
        self.mjpeg_port = mjpeg_port
        self.shutdown_event = shutdown_event

    def run(self):
        camera_ids = [c['id'] for c in self.cameras if c.get('enabled', True)]

        # Set up MJPEG handler shared state
        MJPEGHandler.camera_ids = camera_ids
        MJPEGHandler.latest_frames = {}

        # Start MJPEG server in a thread
        mjpeg_thread = threading.Thread(target=self._run_mjpeg_server, daemon=True)
        mjpeg_thread.start()

        # Frame collector thread: grabs latest frames for MJPEG preview
        collector_thread = threading.Thread(
            target=self._frame_collector, args=(camera_ids,), daemon=True
        )
        collector_thread.start()

        self._log(f'Started on port {self.mjpeg_port} for {len(camera_ids)} cameras')

        # Process evidence requests
        while not self.shutdown_event.is_set():
            try:
                if self.evidence_queue.empty():
                    time.sleep(0.1)
                    continue

                req = self.evidence_queue.get(timeout=1.0)
                req_type = req.get('type', '')

                if req_type == 'snapshot':
                    self._save_snapshot(req)
                elif req_type == 'clip':
                    self._save_clip(req)

            except Exception as e:
                if not self.shutdown_event.is_set():
                    self._log(f'Error processing evidence: {e}')
                    time.sleep(0.1)

        self._log('Shutting down')

    def _run_mjpeg_server(self):
        try:
            class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
                daemon_threads = True

            server = ThreadedHTTPServer(('0.0.0.0', self.mjpeg_port), MJPEGHandler)
            server.timeout = 1.0

            while not self.shutdown_event.is_set():
                server.handle_request()

            server.server_close()
        except Exception as e:
            self._log(f'MJPEG server error: {e}')

    def _frame_collector(self, camera_ids: List[str]):
        """Continuously grabs latest frames from preview queue and encodes as JPEG."""
        while not self.shutdown_event.is_set():
            for cam_id in camera_ids:
                queue = self.preview_queues.get(cam_id)
                if queue is None or queue.empty():
                    continue

                frame_data = None
                # Drain to latest frame (drop older ones)
                try:
                    while not queue.empty():
                        frame_data = queue.get_nowait()
                except Exception:
                    pass

                if frame_data is not None:
                    frame = frame_data.get('frame')
                    if frame is not None:
                        try:
                            _, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
                            with MJPEGHandler.frame_lock:
                                MJPEGHandler.latest_frames[cam_id] = jpeg.tobytes()
                        except Exception:
                            pass

            time.sleep(0.05)  # ~20fps collector rate

    def _save_snapshot(self, req: Dict[str, Any]):
        cam_id = req.get('camera_id', '')
        path = req.get('path', '')

        if not path:
            return

        # Get latest JPEG from MJPEG buffer (thread-safe)
        with MJPEGHandler.frame_lock:
            jpeg = MJPEGHandler.latest_frames.get(cam_id)
        if jpeg:
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, 'wb') as f:
                    f.write(jpeg)
                self._log(f'Snapshot saved: {path}')
            except Exception as e:
                self._log(f'Snapshot save failed: {e}')

    def _save_clip(self, req: Dict[str, Any]):
        """Save a video clip (placeholder - requires ring buffer integration)."""
        self._log(f'Clip save requested for {req.get("camera_id", "?")}')

    def _log(self, msg: str):
        try:
            print(f'[Evidence] {msg}', file=sys.stderr, flush=True)
        except Exception:
            pass
