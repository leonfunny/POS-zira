"""
Business Analytics Rules

- Customer Flow & Heatmap: count per hour, average wait time, heatmap
- Staff Performance: time at workstation vs idle
"""

import time
from datetime import datetime
from typing import Dict, List, Any, Optional

from .loitering import point_in_polygon


class AnalyticsRule:
    """Collects business analytics data (non-alerting)."""

    def __init__(self, camera_config: Dict[str, Any], algorithm: str):
        self.cam_id = camera_config['id']
        self.algorithm = algorithm  # 'analytics_flow' or 'analytics_staff'
        self.zones = camera_config.get('zones', [])

        # Hourly customer count (24 slots)
        self.hourly_count = [0] * 24
        self.current_hour = datetime.now().hour

        # Heatmap: grid of position frequency
        self.heatmap_grid_size = 20  # 20x20 grid
        self.heatmap = [[0] * self.heatmap_grid_size for _ in range(self.heatmap_grid_size)]

        # Track IDs already counted this hour
        self.counted_tracks: set = set()

        # Zone dwell tracking for staff metrics
        self.zone_time: Dict[str, Dict[str, float]] = {}  # zone_id → {active_seconds, idle_seconds}

        # Last analytics emit time
        self.last_emit = 0.0
        self.emit_interval = 60.0  # emit every 60 seconds

    def evaluate(
        self,
        tracks: List[Dict[str, Any]],
        timestamp: float,
        frame_shape: tuple,
    ) -> List[Dict[str, Any]]:
        # No alerts from analytics — just collect data
        now = datetime.now()
        current_hour = now.hour

        # Reset hourly count on hour change
        if current_hour != self.current_hour:
            self.current_hour = current_hour
            self.counted_tracks.clear()

        persons = [t for t in tracks if t.get('class_name') == 'person']

        for person in persons:
            track_id = person['track_id']
            bbox = person.get('bbox', [0, 0, 0, 0])
            cx, cy = bbox[0], bbox[1]

            # Count unique persons per hour
            if track_id not in self.counted_tracks:
                self.counted_tracks.add(track_id)
                self.hourly_count[current_hour] += 1

            # Update heatmap (bounds-checked for negative/out-of-range values)
            gx = max(0, min(int(cx * self.heatmap_grid_size), self.heatmap_grid_size - 1))
            gy = max(0, min(int(cy * self.heatmap_grid_size), self.heatmap_grid_size - 1))
            self.heatmap[gy][gx] += 1

            # Zone time tracking (for staff analytics)
            if self.algorithm == 'analytics_staff':
                for zone in self.zones:
                    zone_id = zone['id']
                    polygon = zone.get('polygon', [])
                    if not polygon:
                        continue

                    if zone_id not in self.zone_time:
                        self.zone_time[zone_id] = {'active': 0, 'idle': 0, 'customers': 0}

                    in_zone = point_in_polygon(cx, cy, polygon)
                    if in_zone:
                        self.zone_time[zone_id]['active'] += 0.25  # approximate per-frame seconds

        return []  # No alerts

    def get_analytics(self) -> Optional[Dict[str, Any]]:
        """Return analytics data periodically."""
        now = time.time()
        if now - self.last_emit < self.emit_interval:
            return None

        self.last_emit = now

        result: Dict[str, Any] = {
            'camera_id': self.cam_id,
            'date': datetime.now().strftime('%Y-%m-%d'),
            'algorithm': self.algorithm,
        }

        if self.algorithm == 'analytics_flow':
            # Find peak hour
            peak_hour = max(range(24), key=lambda h: self.hourly_count[h])
            result.update({
                'hourly_count': list(self.hourly_count),
                'peak_hour': peak_hour,
                'total_today': sum(self.hourly_count),
                'heatmap': [row[:] for row in self.heatmap],
            })

        elif self.algorithm == 'analytics_staff':
            staff_metrics = []
            for zone in self.zones:
                zone_id = zone['id']
                times = self.zone_time.get(zone_id, {'active': 0, 'idle': 0, 'customers': 0})
                staff_metrics.append({
                    'zoneId': zone_id,
                    'zoneName': zone.get('name', zone_id),
                    'activeMinutes': round(times['active'] / 60, 1),
                    'idleMinutes': round(times['idle'] / 60, 1),
                    'estimatedCustomersServed': int(times['customers']),
                })
            result['staff_metrics'] = staff_metrics

        return result
