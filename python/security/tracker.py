"""
Process C: Per-camera Tracker + Rule Engine

Receives detections from inference, applies ByteTrack tracking,
then evaluates per-camera rules (loitering, fire, theft, etc.)
to generate alerts.
"""

import multiprocessing as mp
from multiprocessing import Queue, Event as MpEvent
import threading
import time
import sys
import uuid
import queue as stdlib_queue
from typing import Dict, List, Any

import numpy as np

from .rules.loitering import LoiteringRule
from .rules.recording import RecordingRule
from .rules.theft import TheftRule
from .rules.fire import FireRule
from .rules.analytics import AnalyticsRule


class CameraTracker(threading.Thread):
    """Tracks objects and evaluates rules for a single camera."""

    def __init__(
        self,
        camera_config: Dict[str, Any],
        detection_queue: Queue,
        alert_queue: Queue,
        analytics_queue: Queue,
        global_config: Dict[str, Any],
        shutdown_event: MpEvent,
    ):
        super().__init__(daemon=True)
        self.config = camera_config
        self.cam_id = camera_config['id']
        self.cam_name = camera_config.get('name', self.cam_id)
        self.detection_queue = detection_queue
        self.alert_queue = alert_queue
        self.analytics_queue = analytics_queue
        self.global_config = global_config
        self.shutdown_event = shutdown_event

        self.track_count = 0
        self.next_track_id = 1
        self.tracks: Dict[int, Dict[str, Any]] = {}  # track_id -> state

        # Cooldown tracking: (algorithm, track_id) -> last_alert_time
        self.cooldowns: Dict[str, float] = {}
        self.cooldown_seconds = global_config.get('cooldownSeconds', 300)

        # Initialize rules based on camera algorithms
        self.rules: List[Any] = []
        algorithms = camera_config.get('algorithms', [])
        for algo in algorithms:
            if algo == 'loitering':
                self.rules.append(LoiteringRule(camera_config))
            elif algo == 'recording':
                self.rules.append(RecordingRule(camera_config))
            elif algo == 'theft':
                self.rules.append(TheftRule(camera_config, global_config))
            elif algo == 'fire':
                self.rules.append(FireRule(camera_config))
            elif algo in ('analytics_flow', 'analytics_staff'):
                self.rules.append(AnalyticsRule(camera_config, algo))

    def run(self):
        self._log(f'Started with {len(self.rules)} rules')

        while not self.shutdown_event.is_set():
            try:
                try:
                    det_data = self.detection_queue.get(timeout=0.5)
                except (stdlib_queue.Empty, Exception):
                    continue
                detections = det_data.get('detections', [])
                timestamp = det_data.get('timestamp', time.time())
                frame_shape = det_data.get('frame_shape', (480, 640))

                # Simple tracking: assign IDs based on IoU with existing tracks
                assigned = self._assign_tracks(detections, timestamp)

                # Evaluate rules
                for rule in self.rules:
                    alerts = rule.evaluate(assigned, timestamp, frame_shape)
                    for alert in alerts:
                        # Apply cooldown
                        cooldown_key = f"{alert.get('algorithm', '')}:{alert.get('trackId', 0)}"
                        now = time.time()
                        last_alert = self.cooldowns.get(cooldown_key, 0)
                        if now - last_alert < self.cooldown_seconds:
                            continue

                        self.cooldowns[cooldown_key] = now

                        # Enrich alert
                        alert['id'] = str(uuid.uuid4())
                        alert['cameraId'] = self.cam_id
                        alert['cameraName'] = self.cam_name
                        alert['timestamp'] = int(now * 1000)

                        try:
                            self.alert_queue.put_nowait(alert)
                        except Exception:
                            pass

                # Collect analytics
                for rule in self.rules:
                    if hasattr(rule, 'get_analytics'):
                        analytics = rule.get_analytics()
                        if analytics:
                            try:
                                self.analytics_queue.put_nowait(analytics)
                            except Exception:
                                pass

                # Prune old tracks
                self._prune_tracks(timestamp)

            except Exception as e:
                if not self.shutdown_event.is_set():
                    self._log(f'Error: {e}')
                    time.sleep(0.1)

        self._log('Stopped')

    def _assign_tracks(self, detections: List[Dict], timestamp: float) -> List[Dict]:
        """Simple centroid-based tracker (lightweight ByteTrack alternative)."""
        assigned = []

        for det in detections:
            bbox = det.get('bbox', [0, 0, 0, 0])
            cx, cy = bbox[0], bbox[1]

            best_track_id = None
            best_dist = 0.1  # max distance threshold (normalized)

            for track_id, track in self.tracks.items():
                tcx, tcy = track['cx'], track['cy']
                dist = ((cx - tcx) ** 2 + (cy - tcy) ** 2) ** 0.5
                if dist < best_dist:
                    best_dist = dist
                    best_track_id = track_id

            if best_track_id is not None:
                # Update existing track
                track = self.tracks[best_track_id]
                track['cx'] = cx
                track['cy'] = cy
                track['bbox'] = bbox
                track['last_seen'] = timestamp
                track['class_name'] = det.get('class_name', 'unknown')
                track['confidence'] = det.get('confidence', 0)
                track['frames_seen'] += 1
            else:
                # New track
                best_track_id = self.next_track_id
                self.next_track_id += 1
                self.track_count += 1
                self.tracks[best_track_id] = {
                    'cx': cx,
                    'cy': cy,
                    'bbox': bbox,
                    'first_seen': timestamp,
                    'last_seen': timestamp,
                    'class_name': det.get('class_name', 'unknown'),
                    'confidence': det.get('confidence', 0),
                    'frames_seen': 1,
                }

            assigned.append({
                **det,
                'track_id': best_track_id,
                'dwell_seconds': timestamp - self.tracks[best_track_id]['first_seen'],
            })

        return assigned

    def _prune_tracks(self, current_time: float, max_age: float = 10.0):
        """Remove tracks not seen for max_age seconds."""
        expired = [
            tid for tid, t in self.tracks.items()
            if current_time - t['last_seen'] > max_age
        ]
        for tid in expired:
            # Notify rules about track loss
            for rule in self.rules:
                if hasattr(rule, 'on_track_lost'):
                    rule.on_track_lost(tid, self.tracks[tid])
            del self.tracks[tid]

    def _log(self, msg: str):
        try:
            print(f'[Tracker:{self.cam_id}] {msg}', file=sys.stderr, flush=True)
        except Exception:
            pass


class TrackerProcess(mp.Process):
    """Manages per-camera tracker threads."""

    def __init__(
        self,
        cameras: List[Dict[str, Any]],
        detection_queues: Dict[str, Queue],
        alert_queue: Queue,
        analytics_queue: Queue,
        config: Dict[str, Any],
        shutdown_event: MpEvent,
    ):
        super().__init__(daemon=True)
        self.cameras = cameras
        self.detection_queues = detection_queues
        self.alert_queue = alert_queue
        self.analytics_queue = analytics_queue
        self.config = config
        self.shutdown_event = shutdown_event

    def run(self):
        trackers: List[CameraTracker] = []

        for cam in self.cameras:
            cam_id = cam['id']
            if not cam.get('enabled', True) or not cam.get('aiEnabled', True):
                continue
            det_queue = self.detection_queues.get(cam_id)
            if det_queue is None:
                continue

            tracker = CameraTracker(
                cam, det_queue, self.alert_queue, self.analytics_queue,
                self.config, self.shutdown_event,
            )
            tracker.start()
            trackers.append(tracker)

        print(f'[Tracker] Started {len(trackers)} camera trackers', file=sys.stderr, flush=True)

        while not self.shutdown_event.is_set():
            self.shutdown_event.wait(timeout=5.0)

        print('[Tracker] Shutting down', file=sys.stderr, flush=True)
