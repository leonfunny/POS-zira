import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_FLOOR_SURFACE_THEME,
  FLOOR_SURFACE_THEME_STORAGE_KEY,
  resolveFloorSurfaceTheme,
  type FloorSurfaceTheme,
} from '../constants';

export function useFloorSurfaceTheme() {
  const [floorSurfaceTheme, setFloorSurfaceThemeState] = useState<FloorSurfaceTheme>(
    DEFAULT_FLOOR_SURFACE_THEME,
  );

  useEffect(() => {
    try {
      setFloorSurfaceThemeState(
        resolveFloorSurfaceTheme(localStorage.getItem(FLOOR_SURFACE_THEME_STORAGE_KEY)),
      );
    } catch {
      setFloorSurfaceThemeState(DEFAULT_FLOOR_SURFACE_THEME);
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key === FLOOR_SURFACE_THEME_STORAGE_KEY) {
        setFloorSurfaceThemeState(resolveFloorSurfaceTheme(event.newValue));
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const setFloorSurfaceTheme = useCallback((nextTheme: FloorSurfaceTheme) => {
    setFloorSurfaceThemeState(nextTheme);
    try {
      localStorage.setItem(FLOOR_SURFACE_THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The in-memory preference still works when storage is unavailable.
    }
  }, []);

  return { floorSurfaceTheme, setFloorSurfaceTheme };
}
