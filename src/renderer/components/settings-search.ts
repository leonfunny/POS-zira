function normalizeSettingsSearchValue(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function matchesSettingSection(query: string, haystack: string): boolean {
  const normalizedQuery = normalizeSettingsSearchValue(query).trim();
  if (!normalizedQuery) return true;
  return normalizeSettingsSearchValue(haystack).includes(normalizedQuery);
}
