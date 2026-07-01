import React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'md' | 'lg' | 'kiosk';

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 focus-visible:ring-brand-200',
  secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 focus-visible:ring-brand-200',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-200',
  ghost: 'bg-transparent text-slate-700 hover:bg-slate-100 focus-visible:ring-brand-200',
};

const sizeClasses: Record<ButtonSize, string> = {
  md: 'min-h-11 px-4 text-sm',
  lg: 'min-h-[56px] px-6 text-base',
  kiosk: 'min-h-[64px] px-6 text-xl',
};

const baseClasses = [
  'inline-flex items-center justify-center gap-2 rounded-lg font-extrabold',
  'transition-colors touch-manipulation',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');

export function buttonClassNames(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className = '',
) {
  return `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`.trim();
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    icon,
    children,
    className = '',
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClassNames(variant, size, className)}
      {...props}
    >
      {icon && (
        <span className="inline-flex shrink-0 items-center justify-center" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </button>
  );
});

export default Button;
