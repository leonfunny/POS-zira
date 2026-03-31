import { getTranslation, Language } from './translations';

export function useTranslation(lang: Language) {
  const t = getTranslation(lang);
  return { t };
}
