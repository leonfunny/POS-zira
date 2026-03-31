"""
Loitering Detection Rule

Detect person → Track ID → ROI check:
- Pass through < 5s → ignore
- Stay in ROI > dwell_threshold → increase suspicion
- Return 3+ times in return_window → HIGH alert
"""

import time
from typing import Dict, List, Any, Optional


def point_in_polygon(px: float, py: float, polygon: List[Dict[str, float]]) -> bool:
    """Ray-casting algorithm for point-in-polygon test."""
    n = len(polygon)
    if n < 3:
        return False
    inside = False
    j = n - 1
    try:
        for i in range(n):
            xi, yi = float(polygon[i]['x']), float(polygon[i]['y'])
            xj, yj = float(polygon[j]['x']), float(polygon[j]['y'])
            if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
                inside = not inside
            j = i
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return False
    return inside


class LoiteringRule:
    """Evaluates loitering behavior in configured ROI zones."""

    def __init__(self, camera_config: Dict[str, Any]):
        self.cam_id = camera_config['id']
        self.zones = camera_config.get('zones', [])
        self.dwell_threshold = camera_config.get('loiterDwellSeconds', 30)
        self.return_window = camera_config.get('loiterReturnWindow', 10) * 60  # minutes → seconds
        self.return_count = camera_config.get('loiterReturnCount', 3)

        # Track ID → {zone_id → first_entered_time}
        self.track_zone_entry: Dict[int, Dict[str, float]] = {}
        # Track ID → list of visit timestamps for return detection
        self.track_visits: Dict[int, List[float]] = {}
        # Track ID → set of alerted zones (prevent duplicate alerts per visit)
        self.alerted: Dict[int, set] = {}

    def evaluate(
        self,
        tracks: List[Dict[str, Any]],
        timestamp: float,
        frame_shape: tuple,
    ) -> List[Dict[str, Any]]:
        alerts = []
        monitoring_zones = [z for z in self.zones if z.get('type') in ('monitoring', 'restricted')]

        for track in tracks:
            if track.get('class_name') != 'person':
                continue

            track_id = track['track_id']
            bbox = track.get('bbox', [0, 0, 0, 0])
            cx, cy = bbox[0], bbox[1]  # normalized center

            if track_id not in self.track_zone_entry:
                self.track_zone_entry[track_id] = {}
            if track_id not in self.alerted:
                self.alerted[track_id] = set()

            for zone in monitoring_zones:
                zone_id = zone['id']
                polygon = zone.get('polygon', [])
                if not polygon:
                    continue

                in_zone = point_in_polygon(cx, cy, polygon)

                if in_zone:
                    if zone_id not in self.track_zone_entry[track_id]:
                        self.track_zone_entry[track_id][zone_id] = timestamp
                        # Record visit
                        if track_id not in self.track_visits:
                            self.track_visits[track_id] = []
                        self.track_visits[track_id].append(timestamp)

                    entry_time = self.track_zone_entry[track_id][zone_id]
                    dwell = timestamp - entry_time

                    # Check dwell threshold
                    if dwell >= self.dwell_threshold and zone_id not in self.alerted[track_id]:
                        self.alerted[track_id].add(zone_id)

                        # Check return count for severity
                        visits = self.track_visits.get(track_id, [])
                        recent_visits = [v for v in visits if timestamp - v < self.return_window]
                        severity = 'high' if len(recent_visits) >= self.return_count else 'medium'

                        alerts.append({
                            'algorithm': 'loitering',
                            'severity': severity,
                            'message': f'Person loitering in {zone.get("name", zone_id)} for {int(dwell)}s'
                                       + (f' ({len(recent_visits)} visits)' if len(recent_visits) > 1 else ''),
                            'trackId': track_id,
                            'dwellSeconds': int(dwell),
                            'bbox': bbox,
                        })
                else:
                    # Left zone
                    if zone_id in self.track_zone_entry.get(track_id, {}):
                        del self.track_zone_entry[track_id][zone_id]

        return alerts

    def on_track_lost(self, track_id: int, track_state: Dict[str, Any]):
        """Clean up when a track disappears."""
        self.track_zone_entry.pop(track_id, None)
        self.alerted.pop(track_id, None)
        # Keep visits for return detection (cleaned by window)
