import React from 'react';

interface PanelProps {
  children: React.ReactNode;
  className?: string;
}

export function Panel({ children, className = '' }: PanelProps) {
  return (
    <div
      className={`rounded-[28px] border border-white/80 bg-white/88 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur ${className}`.trim()}
    >
      {children}
    </div>
  );
}

interface ActionCardProps {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  accent?: 'brand' | 'amber' | 'slate';
  layout?: 'primary' | 'secondary';
  onClick: () => void;
}

const ACCENT_STYLES = {
  brand: 'from-brand-500/14 via-brand-100/60 to-white',
  amber: 'from-amber-400/16 via-amber-100/60 to-white',
  slate: 'from-slate-300/18 via-slate-100/70 to-white',
};

export function ActionCard({
  title,
  subtitle,
  icon,
  accent = 'brand',
  layout = 'secondary',
  onClick,
}: ActionCardProps) {
  const sizeClasses = layout === 'primary'
    ? 'min-h-[240px] p-7 text-left'
    : 'min-h-[180px] p-6 text-left';

  return (
    <button
      onClick={onClick}
      className={`group relative overflow-hidden rounded-[28px] border border-white/80 bg-gradient-to-br ${ACCENT_STYLES[accent]} shadow-[0_18px_50px_rgba(15,23,42,0.08)] transition-all hover:-translate-y-1 hover:shadow-[0_28px_70px_rgba(15,23,42,0.12)] active:translate-y-0 ${sizeClasses}`.trim()}
    >
      <div className="absolute right-5 top-5 rounded-2xl border border-white/80 bg-white/80 p-3 text-slate-700 shadow-sm">
        {icon}
      </div>

      <div className="relative flex h-full max-w-[80%] flex-col justify-end">
        <div className="text-2xl font-semibold tracking-tight text-slate-900">
          {title}
        </div>
        {subtitle && (
          <div className="mt-2 text-sm leading-6 text-slate-500">
            {subtitle}
          </div>
        )}
      </div>

      <div className="absolute bottom-5 right-5 text-slate-400 transition-colors group-hover:text-brand-600">
        <ArrowIcon />
      </div>
    </button>
  );
}

interface DetailRowProps {
  label: string;
  value: string;
}

export function DetailRow({ label, value }: DetailRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 py-3 last:border-b-0">
      <span className="text-sm font-medium text-slate-500">{label}</span>
      <span className="text-sm font-semibold text-slate-900">{value}</span>
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <Panel className="flex min-h-[260px] flex-col items-center justify-center px-8 py-10 text-center">
      <div className="rounded-full bg-slate-100 p-4 text-slate-500">
        <InfoIcon />
      </div>
      <h3 className="mt-5 text-2xl font-semibold tracking-tight text-slate-900">{title}</h3>
      {description && (
        <p className="mt-3 max-w-md text-base leading-7 text-slate-500">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </Panel>
  );
}

function ArrowIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 6l6 6-6 6" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8h.01" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M11 12h1v4h1" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 100-18 9 9 0 000 18z" />
    </svg>
  );
}
