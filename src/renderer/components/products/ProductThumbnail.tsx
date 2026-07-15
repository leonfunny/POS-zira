import React, { useEffect, useState } from 'react';
import { Package } from 'lucide-react';
import type { ProductListItem } from '../../hooks/useProducts';

interface ProductThumbnailProps {
  product: Pick<ProductListItem, 'thumbnail_url' | 'image_url'>;
  alt: string;
  className?: string;
  iconSize?: number;
}

export default function ProductThumbnail({
  product,
  alt,
  className = 'h-12 w-12',
  iconSize = 22,
}: ProductThumbnailProps) {
  const source = product.thumbnail_url || product.image_url || '';
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [source]);

  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-slate-100 text-slate-400 ${className}`}
    >
      {source && !failed ? (
        <img
          src={source}
          alt={alt}
          loading="lazy"
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <Package aria-hidden="true" size={iconSize} />
      )}
    </span>
  );
}
