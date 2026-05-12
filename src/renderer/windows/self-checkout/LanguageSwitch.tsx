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
          className={`sc-language-button sc-focusable ${
            compact ? '!min-h-[46px] !min-w-[58px] text-sm' : ''
          }`}
          data-active={l.code === lang}
          aria-label={l.label}
        >
          {l.flag}
        </button>
      ))}
    </div>
  );
}
