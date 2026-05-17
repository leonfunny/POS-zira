import React from 'react';
import { ScLanguage, SC_LANGUAGES } from './i18n';

interface LanguageSwitchProps {
  lang: ScLanguage;
  onLangChange: (lang: ScLanguage) => void;
  compact?: boolean;
  className?: string;
}

export default function LanguageSwitch({
  lang,
  onLangChange,
  compact = false,
  className = '',
}: LanguageSwitchProps) {
  return (
    <div className={`flex gap-2 ${className}`}>
      {SC_LANGUAGES.map((l) => (
        <button
          key={l.code}
          type="button"
          onClick={() => onLangChange(l.code)}
          className={`sc-language-button sc-focusable flex flex-col items-center justify-center leading-tight ${
            compact ? '!min-h-[46px] !min-w-[64px] px-2 text-sm' : 'px-3'
          }`}
          data-active={l.code === lang}
          aria-label={l.label}
        >
          <span className="text-base font-black tracking-wide">{l.flag}</span>
          <span
            className={`mt-0.5 font-bold ${compact ? 'text-[10px]' : 'text-xs'} text-[var(--sc-muted)]`}
          >
            {l.label}
          </span>
        </button>
      ))}
    </div>
  );
}
