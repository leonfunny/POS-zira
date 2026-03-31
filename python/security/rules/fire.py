"""
Fire & Smoke Detection Rule

- Detect fire/smoke class continuously for N seconds → Alert
- Smoke area expanding rapidly → Alert
- → CRITICAL alert + immediate clip + Telegram
"""

import time
from typing import Dict, List, Any


# YOLO fire/smoke class names (may vary by model)
FIRE_CLASSES = {'fire', 'flame', 'smoke'}


class FireRule:
    """Detects fire and smoke via persistent detection."""

    def __init__(self, camera_config: Dict[str, Any]):
        self.cam_id = camera_config['id']
        self.persist_threshold = camera_config.get('firePersistSeconds', 3)

        # Detection state: class_name → {first_detected, last_detected, area_history}
        self.detection_state: Dict[str, Dict[str, Any]] = {}
        self.alerted_classes: set = set()

    def evaluate(
        self,
        tracks: List[Dict[str, Any]],
        timestamp: float,
        frame_shape: tuple,
    ) -> List[Dict[str, Any]]:
        alerts = []

        # Find fire/smoke detections
        fire_detections = [
            t for t in tracks
            if t.get('class_name', '').lower() in FIRE_CLASSES
        ]

        detected_classes: set = set()

        for det in fire_detections:
            class_name = det['class_name'].lower()
            detected_classes.add(class_name)
            bbox = det.get('bbox', [0, 0, 0, 0])
            area = bbox[2] * bbox[3]  # normalized w * h

            if class_name not in self.detection_state:
                self.detection_state[class_name] = {
                    'first_detected': timestamp,
                    'last_detected': timestamp,
                    'area_history': [area],
                    'max_area': area,
                }
            else:
                state = self.detection_state[class_name]
                state['last_detected'] = timestamp
                state['area_history'].append(area)
                if len(state['area_history']) > 30:
                    state['area_history'] = state['area_history'][-30:]
                state['max_area'] = max(state['max_area'], area)

            state = self.detection_state[class_name]
            duration = timestamp - state['first_detected']

            # Persistent detection → alert
            if duration >= self.persist_threshold and class_name not in self.alerted_classes:
                self.alerted_classes.add(class_name)

                # Check if area is expanding (rapid growth = more critical)
                area_growth = False
                hist = state['area_history']
                if len(hist) >= 5:
                    early = sum(hist[:3]) / 3
                    late = sum(hist[-3:]) / 3
                    if early > 0 and late / early > 2.0:
                        area_growth = True

                severity = 'critical'
                message = f'{class_name.capitalize()} detected for {int(duration)}s'
                if area_growth:
                    message += ' (rapidly expanding)'

                alerts.append({
                    'algorithm': 'fire',
                    'severity': severity,
                    'message': message,
                    'bbox': bbox,
                })

        # Clear state for classes no longer detected (with grace period)
        for class_name in list(self.detection_state.keys()):
            if class_name not in detected_classes:
                state = self.detection_state[class_name]
                if timestamp - state['last_detected'] > 5.0:
                    del self.detection_state[class_name]
                    # Clear alerted state so fire can re-trigger on next occurrence
                    self.alerted_classes.discard(class_name)

        # Also clear alerted_classes for classes no longer in detection_state
        # This ensures a new detection cycle can generate a new alert
        self.alerted_classes = self.alerted_classes & set(self.detection_state.keys())

        return alerts
