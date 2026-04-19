import React, { useState, useEffect, useRef, useMemo } from 'react';
import IdleView from './IdleView';

interface PromoViewProps {
  images: string[];
  intervalMs: number;
  fallback?: React.ReactNode;
}

export default function PromoView({ images, intervalMs, fallback }: PromoViewProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stabilize images array reference across IPC re-serializations
  // Only change when the actual image URLs change
  const imagesKey = JSON.stringify(images);
  const stableImages = useMemo(() => images, [imagesKey]);

  // Reset index when images change
  useEffect(() => {
    setCurrentIndex(0);
  }, [stableImages]);

  useEffect(() => {
    if (stableImages.length <= 1) return;

    timerRef.current = setInterval(() => {
      setIsTransitioning(true);
      fadeTimerRef.current = setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % stableImages.length);
        setIsTransitioning(false);
      }, 500); // fade duration
    }, intervalMs);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, [stableImages, intervalMs]);

  if (stableImages.length === 0) {
    return fallback ? <>{fallback}</> : <IdleView />;
  }

  // Guard against stale index after image list shrinks
  const safeIndex = currentIndex < stableImages.length ? currentIndex : 0;

  return (
    <div className="w-full h-screen bg-gradient-to-br from-white via-rose-50 to-amber-50 relative overflow-hidden">
      <img
        key={safeIndex}
        src={stableImages[safeIndex]}
        alt=""
        className="w-full h-full object-contain transition-opacity duration-500"
        style={{ opacity: isTransitioning ? 0 : 1 }}
        draggable={false}
      />

      {/* Dot indicators */}
      {stableImages.length > 1 && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-2">
          {stableImages.map((_, i) => (
            <div
              key={i}
              className={`w-2.5 h-2.5 rounded-full transition-colors duration-300 ${
                i === safeIndex ? 'bg-brand-500' : 'bg-slate-300'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
