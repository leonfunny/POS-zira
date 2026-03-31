"""
Suspicious Recording Behavior Detection

Detect person + cell phone (YOLO classes 0 + 67):
- Phone near face (bbox proximity check)
- Standing still > X seconds
- → Alert: "Possible recording behavior"
"""

import time
from typing import Dict, List, Any


class RecordingRule:
    """Detects suspicious recording behavior."""

    def __init__(self, camera_config: Dict[str, Any]):
        self.cam_id = camera_config['id']
        self.dwell_threshold = 10.0  # seconds standing still with phone

        # Track ID → {has_phone_near_face, still_since, alerted}
        self.track_state: Dict[int, Dict[str, Any]] = {}

    def evaluate(
        self,
        tracks: List[Dict[str, Any]],
        timestamp: float,
        frame_shape: tuple,
    ) -> List[Dict[str, Any]]:
        alerts = []

        # Find all persons and phones
        persons = [t for t in tracks if t.get('class_name') == 'person']
        phones = [t for t in tracks if t.get('class_name') == 'cell phone']

        for person in persons:
            track_id = person['track_id']
            pbbox = person.get('bbox', [0, 0, 0, 0])
            pcx, pcy = pbbox[0], pbbox[1]

            if track_id not in self.track_state:
                self.track_state[track_id] = {
                    'has_phone': False,
                    'still_since': timestamp,
                    'last_cx': pcx,
                    'last_cy': pcy,
                    'alerted': False,
                }

            state = self.track_state[track_id]

            # Check if phone is near this person
            phone_near = False
            for phone in phones:
                phone_bbox = phone.get('bbox', [0, 0, 0, 0])
                phone_cx, phone_cy = phone_bbox[0], phone_bbox[1]

                # Proximity: phone within person bbox + margin
                pw, ph = pbbox[2], pbbox[3]
                if (abs(phone_cx - pcx) < pw * 0.8 and abs(phone_cy - pcy) < ph * 0.6):
                    phone_near = True
                    break

            state['has_phone'] = phone_near

            # Check if standing still (movement < threshold)
            movement = ((pcx - state['last_cx']) ** 2 + (pcy - state['last_cy']) ** 2) ** 0.5
            if movement > 0.02:  # moved significantly
                state['still_since'] = timestamp
            state['last_cx'] = pcx
            state['last_cy'] = pcy

            # Evaluate: phone near face + standing still
            if phone_near:
                still_duration = timestamp - state['still_since']
                if still_duration >= self.dwell_threshold and not state['alerted']:
                    state['alerted'] = True
                    alerts.append({
                        'algorithm': 'recording',
                        'severity': 'medium',
                        'message': f'Possible recording behavior detected ({int(still_duration)}s with phone)',
                        'trackId': track_id,
                        'dwellSeconds': int(still_duration),
                        'bbox': pbbox,
                    })

        return alerts

    def on_track_lost(self, track_id: int, track_state: Dict[str, Any]):
        self.track_state.pop(track_id, None)
