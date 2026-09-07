import React, { useState, type ImgHTMLAttributes, type ReactNode } from 'react';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'onError'> & { fallback: ReactNode };

function ImageAttempt({ fallback, ...props }: Props) {
  const [failed, setFailed] = useState(false);
  return failed ? <>{fallback}</> : <img {...props} onError={() => setFailed(true)} />;
}

/** Reset failure state for each new source, including when a previous URL returns. */
export default function ImageWithFallback({ src, fallback, ...props }: Props) {
  if (!src?.trim()) return <>{fallback}</>;
  return <ImageAttempt key={src} src={src} fallback={fallback} {...props} />;
}
