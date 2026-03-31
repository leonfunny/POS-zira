"""
Anti-Theft / Intrusion Detection Rule

- Non-staff in restricted ROI > X seconds → Alert
- Any person detected after closing hours → Alert
- Person near cash register outside business hours → HIGH alert
"""

import time
from datetime import datetime
from typing import Dict, List, Any

from .loitering import point_in_polygon


class TheftRule:
    """Detects intrusion into restricted zones and after-hours presence."""

    def __init__(self, camera_config: Dict[str, Any], global_config: Dict[str, Any]):
        self.cam_id = camera_config['id']
        self.zones = camera_config.get('zones', [])
        self.dwell_threshold = camera_config.get('theftDwellSeconds', 15)

        # Business hours from global config
        self.business_start = global_config.get('businessHoursStart', '09:00')
        self.business_end = global_config.get('businessHoursEnd', '21:00')
        self.business_days = global_config.get('businessDays', [1, 2, 3, 4, 5, 6])

        # Track ID → {zone_id → entry_time}
        self.track_zone_entry: Dict[int, Dict[str, float]] = {}
        self.alerted: Dict[int, set] = {}

    def _is_business_hours(self) -> bool:
        now = datetime.now()
        weekday = now.isoweekday()  # 1=Mon, 7=Sun
        if weekday not in self.business_days:
            return False

        try:
            start_h, start_m = map(int, self.business_start.split(':'))
            end_h, end_m = map(int, self.business_end.split(':'))
            current_minutes = now.hour * 60 + now.minute
            start_minutes = start_h * 60 + start_m
            end_minutes = end_h * 60 + end_m
            return start_minutes <= current_minutes <= end_minutes
        except Exception:
            return True  # Default to business hours if parsing fails

    def evaluate(
        self,
        tracks: List[Dict[str, Any]],
        timestamp: float,
        frame_shape: tuple,
    ) -> List[Dict[str, Any]]:
        alerts = []
        is_business = self._is_business_hours()
        restricted_zones = [z for z in self.zones if z.get('type') == 'restricted']

        for track in tracks:
            if track.get('class_name') != 'person':
                continue

            track_id = track['track_id']
            bbox = track.get('bbox', [0, 0, 0, 0])
            cx, cy = bbox[0], bbox[1]

            if track_id not in self.track_zone_entry:
                self.track_zone_entry[track_id] = {}
            if track_id not in self.alerted:
                self.alerted[track_id] = set()

            # After-hours detection (any person = alert)
            if not is_business:
                after_hours_key = 'after_hours'
                if after_hours_key not in self.alerted[track_id]:
                    self.alerted[track_id].add(after_hours_key)
                    alerts.append({
                        'algorithm': 'theft',
                        'severity': 'high',
                        'message': 'Person detected after business hours',
                        'trackId': track_id,
                        'bbox': bbox,
                    })

            # Restricted zone intrusion
            for zone in restricted_zones:
                zone_id = zone['id']
                polygon = zone.get('polygon', [])
                if not polygon:
                    continue

                in_zone = point_in_polygon(cx, cy, polygon)

                if in_zone:
                    if zone_id not in self.track_zone_entry[track_id]:
                        self.track_zone_entry[track_id][zone_id] = timestamp

                    entry_time = self.track_zone_entry[track_id][zone_id]
                    dwell = timestamp - entry_time

                    if dwell >= self.dwell_threshold and zone_id not in self.alerted[track_id]:
                        self.alerted[track_id].add(zone_id)

                        severity = 'critical' if not is_business else 'high'
                        alerts.append({
                            'algorithm': 'theft',
                            'severity': severity,
                            'message': f'Person in restricted zone "{zone.get("name", zone_id)}" for {int(dwell)}s'
                                       + (' (after hours)' if not is_business else ''),
                            'trackId': track_id,
                            'dwellSeconds': int(dwell),
                            'bbox': bbox,
                        })
                else:
                    if zone_id in self.track_zone_entry.get(track_id, {}):
                        del self.track_zone_entry[track_id][zone_id]

        return alerts

    def on_track_lost(self, track_id: int, track_state: Dict[str, Any]):
        self.track_zone_entry.pop(track_id, None)
        self.alerted.pop(track_id, None)
