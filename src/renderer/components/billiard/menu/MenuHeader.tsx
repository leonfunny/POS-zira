interface MenuHeaderProps {
  name: string;
  widthM: number;
  heightM: number;
  hourlyRate?: number;
  hasImage: boolean;
}

export function MenuHeader({ name, widthM, heightM, hourlyRate, hasImage }: MenuHeaderProps) {
  return (
    <div className="px-3 py-2 border-b border-gray-200">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-sm truncate">{name}</span>
        {!hasImage && (
          <span className="text-xs text-gray-500 tabular-nums whitespace-nowrap">
            {widthM}×{heightM}m
          </span>
        )}
      </div>
      {hourlyRate != null && hourlyRate > 0 && (
        <p className="text-xs text-gray-500 mt-0.5">{hourlyRate} PLN/h</p>
      )}
    </div>
  );
}
