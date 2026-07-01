import React, { useId } from 'react';

export interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: React.ReactNode;
  error?: React.ReactNode;
  helperText?: React.ReactNode;
  containerClassName?: string;
  inputClassName?: string;
  labelClassName?: string;
}

const baseInputClasses = [
  'min-h-11 w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-950',
  'outline-none transition-colors placeholder:text-slate-400',
  'focus:border-brand-500 focus:ring-2 focus:ring-brand-100',
  'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500',
].join(' ');

const labelClasses = 'block text-xs font-medium text-slate-600';
const errorClasses = 'text-xs font-medium text-red-600';
const helperClasses = 'text-xs text-slate-500';

const joinClasses = (...classes: Array<string | undefined | false>) => classes.filter(Boolean).join(' ');

const appendDescribedBy = (
  describedBy: string | undefined,
  nextId: string | undefined,
) => [describedBy, nextId].filter(Boolean).join(' ') || undefined;

const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  {
    label,
    error,
    helperText,
    containerClassName = '',
    inputClassName = '',
    labelClassName = '',
    id,
    className = '',
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    type = 'text',
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const errorId = error ? `${inputId}-error` : undefined;
  const helperId = helperText ? `${inputId}-helper` : undefined;
  const describedBy = appendDescribedBy(
    appendDescribedBy(ariaDescribedBy, helperId),
    errorId,
  );

  return (
    <div className={joinClasses('space-y-1', containerClassName)}>
      {label && (
        <label htmlFor={inputId} className={joinClasses(labelClasses, labelClassName)}>
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        type={type}
        aria-invalid={ariaInvalid ?? (error ? true : undefined)}
        aria-describedby={describedBy}
        className={joinClasses(
          baseInputClasses,
          error ? 'border-red-300 focus:border-red-500 focus:ring-red-100' : 'border-slate-300',
          inputClassName,
          className,
        )}
        {...props}
      />
      {helperText && <p id={helperId} className={helperClasses}>{helperText}</p>}
      {error && <p id={errorId} className={errorClasses}>{error}</p>}
    </div>
  );
});

export default TextInput;
