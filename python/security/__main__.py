"""
Zira AI Security Engine — Multi-process orchestrator.

JSON-RPC over stdio:
  - Reads commands from stdin
  - Writes events/responses to stdout
  - Spawns child processes: ingest, inference, tracker, evidence
"""

import sys
import json
import threading
import time
import signal
import multiprocessing as mp
from multiprocessing import Queue, Event as MpEvent
from typing import Dict, Any, Optional

from .ingest import IngestProcess
from .inference import InferenceProcess
from .tracker import TrackerProcess
from .evidence import EvidenceProcess


class SecurityEngine:
    """Orchestrates all AI security processes."""

    def __init__(self):
        self.running = False
        self.start_time = 0.0
        self.config: Dict[str, Any] = {}
        self.cameras: list = []

        # Inter-process queues
        self.frame_queues: Dict[str, Queue] = {}        # camera_id -> latest frames (for inference)
        self.preview_queues: Dict[str, Queue] = {}      # camera_id -> frames copy (for MJPEG preview)
        self.detection_queues: Dict[str, Queue] = {}     # camera_id -> detections
        self.alert_queue: Queue = Queue(maxsize=200)     # alerts -> main
        self.evidence_queue: Queue = Queue(maxsize=100)  # evidence requests
        self.analytics_queue: Queue = Queue(maxsize=100) # analytics data

        # Processes
        self.ingest_proc: Optional[IngestProcess] = None
        self.inference_proc: Optional[InferenceProcess] = None
        self.tracker_proc: Optional[TrackerProcess] = None
        self.evidence_proc: Optional[EvidenceProcess] = None

        # Shutdown flag
        self.shutdown_event = MpEvent()

        # Heartbeat
        self._heartbeat_timer: Optional[threading.Timer] = None

        # Pending RPC requests
        self._request_id = 0
        self._lock = threading.Lock()

    def handle_command(self, cmd: Dict[str, Any]) -> Dict[str, Any]:
        """Process a JSON-RPC command from Electron."""
        method = cmd.get('method', '')
        params = cmd.get('params', {})
        req_id = cmd.get('id')

        try:
            if method == 'start':
                return self._start(params, req_id)
            elif method == 'stop':
                return self._stop(req_id)
            elif method == 'get_status':
                return self._get_status(req_id)
            elif method == 'update_camera':
                return self._update_camera(params, req_id)
            elif method == 'add_camera':
                return self._add_camera(params, req_id)
            elif method == 'remove_camera':
                return self._remove_camera(params, req_id)
            elif method == 'get_analytics':
                return self._get_analytics(params, req_id)
            elif method == 'capture_snapshot':
                return self._capture_snapshot(params, req_id)
            else:
                return {'id': req_id, 'error': f'Unknown method: {method}'}
        except Exception as e:
            return {'id': req_id, 'error': str(e)}

    def _start(self, params: Dict[str, Any], req_id: Any) -> Dict[str, Any]:
        if self.running:
            return {'id': req_id, 'result': {'already_running': True}}

        self.cameras = params.get('cameras', [])
        self.config = params
        model = params.get('model', 'yolov8n')
        mjpeg_port = params.get('mjpeg_port', 9090)

        if not self.cameras:
            return {'id': req_id, 'error': 'No cameras configured'}

        self.shutdown_event.clear()
        self.start_time = time.time()

        # Create per-camera queues (must be created before spawning processes)
        for cam in self.cameras:
            cam_id = cam['id']
            self.frame_queues[cam_id] = Queue(maxsize=2)
            self.preview_queues[cam_id] = Queue(maxsize=2)
            self.detection_queues[cam_id] = Queue(maxsize=10)

        # Start processes
        try:
            self.ingest_proc = IngestProcess(
                cameras=self.cameras,
                frame_queues=self.frame_queues,
                preview_queues=self.preview_queues,
                shutdown_event=self.shutdown_event,
            )
            self.ingest_proc.start()

            self.inference_proc = InferenceProcess(
                cameras=self.cameras,
                frame_queues=self.frame_queues,
                detection_queues=self.detection_queues,
                model_name=model,
                shutdown_event=self.shutdown_event,
            )
            self.inference_proc.start()

            self.tracker_proc = TrackerProcess(
                cameras=self.cameras,
                detection_queues=self.detection_queues,
                alert_queue=self.alert_queue,
                analytics_queue=self.analytics_queue,
                config=self.config,
                shutdown_event=self.shutdown_event,
            )
            self.tracker_proc.start()

            self.evidence_proc = EvidenceProcess(
                cameras=self.cameras,
                preview_queues=self.preview_queues,
                evidence_queue=self.evidence_queue,
                mjpeg_port=mjpeg_port,
                shutdown_event=self.shutdown_event,
            )
            self.evidence_proc.start()

        except Exception as e:
            self._stop_processes()
            return {'id': req_id, 'error': f'Failed to start processes: {e}'}

        self.running = True
        self._start_heartbeat()

        return {'id': req_id, 'result': {'started': True, 'cameras': len(self.cameras)}}

    def _stop(self, req_id: Any) -> Dict[str, Any]:
        if not self.running:
            return {'id': req_id, 'result': {'already_stopped': True}}

        self._stop_processes()
        self.running = False
        return {'id': req_id, 'result': {'stopped': True}}

    def _stop_processes(self):
        self.shutdown_event.set()
        if self._heartbeat_timer:
            self._heartbeat_timer.cancel()
            self._heartbeat_timer = None

        for proc in [self.evidence_proc, self.tracker_proc, self.inference_proc, self.ingest_proc]:
            if proc and proc.is_alive():
                proc.join(timeout=5)
                if proc.is_alive():
                    proc.terminate()

        # Clear queues
        for q in list(self.frame_queues.values()) + list(self.preview_queues.values()) + list(self.detection_queues.values()):
            try:
                while not q.empty():
                    q.get_nowait()
            except Exception:
                pass

        self.frame_queues.clear()
        self.preview_queues.clear()
        self.detection_queues.clear()

    def _get_status(self, req_id: Any) -> Dict[str, Any]:
        camera_statuses = []
        for cam in self.cameras:
            cam_id = cam['id']
            camera_statuses.append({
                'id': cam_id,
                'name': cam.get('name', cam_id),
                'connected': self.ingest_proc.is_alive() if self.ingest_proc else False,
                'fps': cam.get('aiFps', 8),
                'trackCount': 0,
                'queueDrops': 0,
                'lastFrame': int(time.time() * 1000),
            })

        return {
            'id': req_id,
            'result': {
                'running': self.running,
                'cameras': camera_statuses,
                'totalInferenceFps': sum(c.get('aiFps', 8) for c in self.cameras) if self.running else 0,
                'uptime': int(time.time() - self.start_time) if self.running else 0,
            },
        }

    def _update_camera(self, params: Dict[str, Any], req_id: Any) -> Dict[str, Any]:
        cam_id = params.get('camera_id')
        cam_config = params.get('config', {})
        for i, cam in enumerate(self.cameras):
            if cam['id'] == cam_id:
                self.cameras[i].update(cam_config)
                return {'id': req_id, 'result': {'updated': True}}
        return {'id': req_id, 'error': f'Camera not found: {cam_id}'}

    def _add_camera(self, params: Dict[str, Any], req_id: Any) -> Dict[str, Any]:
        cam_config = params.get('config', {})
        cam_id = cam_config.get('id')
        if not cam_id:
            return {'id': req_id, 'error': 'Camera config missing id'}
        self.cameras.append(cam_config)
        # Note: Queues created after spawn are NOT accessible by running child processes.
        # Hot-add requires a full engine restart to take effect.
        self.frame_queues[cam_id] = Queue(maxsize=2)
        self.preview_queues[cam_id] = Queue(maxsize=2)
        self.detection_queues[cam_id] = Queue(maxsize=10)
        return {'id': req_id, 'result': {'added': True, 'note': 'Restart engine for camera to become active'}}

    def _remove_camera(self, params: Dict[str, Any], req_id: Any) -> Dict[str, Any]:
        cam_id = params.get('camera_id')
        self.cameras = [c for c in self.cameras if c['id'] != cam_id]
        # Note: running child processes still hold references to these queues.
        # They will safely ignore missing cameras. Full restart recommended.
        self.frame_queues.pop(cam_id, None)
        self.preview_queues.pop(cam_id, None)
        self.detection_queues.pop(cam_id, None)
        return {'id': req_id, 'result': {'removed': True, 'note': 'Restart engine for full effect'}}

    def _get_analytics(self, params: Dict[str, Any], req_id: Any) -> Dict[str, Any]:
        # Return last known analytics from the analytics queue
        return {'id': req_id, 'result': {'camera_id': params.get('camera_id'), 'data': None}}

    def _capture_snapshot(self, params: Dict[str, Any], req_id: Any) -> Dict[str, Any]:
        cam_id = params.get('camera_id')
        path = params.get('path', '')
        self.evidence_queue.put({'type': 'snapshot', 'camera_id': cam_id, 'path': path})
        return {'id': req_id, 'result': {'queued': True, 'path': path}}

    def _start_heartbeat(self):
        def heartbeat():
            if not self.running:
                return
            emit_event('heartbeat', {
                'alive': True,
                'cameras': [c['id'] for c in self.cameras],
                'uptime': int(time.time() - self.start_time),
            })
            self._heartbeat_timer = threading.Timer(5.0, heartbeat)
            self._heartbeat_timer.daemon = True
            self._heartbeat_timer.start()

        self._heartbeat_timer = threading.Timer(5.0, heartbeat)
        self._heartbeat_timer.daemon = True
        self._heartbeat_timer.start()

    def poll_alerts(self):
        """Check alert queue and emit events. Called from main loop."""
        while not self.alert_queue.empty():
            try:
                alert = self.alert_queue.get_nowait()
                emit_event('alert', alert)
            except Exception:
                break

    def poll_analytics(self):
        """Check analytics queue and emit events."""
        while not self.analytics_queue.empty():
            try:
                data = self.analytics_queue.get_nowait()
                emit_event('analytics', data)
            except Exception:
                break


def emit_event(event_type: str, data: Any):
    """Write a JSON event to stdout for Electron to read."""
    msg = json.dumps({'event': event_type, 'data': data})
    try:
        sys.stdout.write(msg + '\n')
        sys.stdout.flush()
    except (BrokenPipeError, IOError):
        pass


def emit_response(response: Dict[str, Any]):
    """Write a JSON-RPC response to stdout."""
    msg = json.dumps(response)
    try:
        sys.stdout.write(msg + '\n')
        sys.stdout.flush()
    except (BrokenPipeError, IOError):
        pass


def main():
    engine = SecurityEngine()
    running = True

    def signal_handler(sig, frame):
        nonlocal running
        running = False
        engine._stop(None)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Read commands from stdin in a thread
    def stdin_reader():
        nonlocal running
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
                response = engine.handle_command(cmd)
                if response:
                    emit_response(response)
            except json.JSONDecodeError:
                emit_response({'id': None, 'error': 'Invalid JSON'})
            except Exception as e:
                emit_response({'id': None, 'error': str(e)})
        running = False

    reader_thread = threading.Thread(target=stdin_reader, daemon=True)
    reader_thread.start()

    # Main loop: poll queues and emit events
    while running:
        try:
            engine.poll_alerts()
            engine.poll_analytics()
            time.sleep(0.1)
        except KeyboardInterrupt:
            break

    engine._stop(None)


if __name__ == '__main__':
    mp.set_start_method('spawn', force=True)
    main()
