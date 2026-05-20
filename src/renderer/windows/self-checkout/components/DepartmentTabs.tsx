import React from 'react';
import { ChefHat, ShoppingBasket } from 'lucide-react';
import type { CatalogDepartment } from '../types';
import type { ScLanguage } from '../i18n';
import { getScStrings } from '../i18n';

interface DepartmentTabsProps {
  lang: ScLanguage;
  activeDepartment: CatalogDepartment;
  onChange: (department: CatalogDepartment) => void;
}

export default function DepartmentTabs({
  lang,
  activeDepartment,
  onChange,
}: DepartmentTabsProps) {
  const t = getScStrings(lang);

  const baseClass = 'sc-category-button sc-focusable flex min-h-[82px] items-center justify-center gap-3 rounded-2xl border-2 px-4 text-2xl font-black';
  const activeClass = 'border-[var(--sc-primary)] bg-[var(--sc-primary-soft)] text-[var(--sc-primary-deep)]';
  const inactiveClass = 'border-[var(--sc-border)] bg-white text-[var(--sc-ink)]';

  return (
    <div className="grid grid-cols-2 gap-3">
      <button
        type="button"
        onClick={() => onChange('grocery')}
        className={`${baseClass} ${activeDepartment === 'grocery' ? activeClass : inactiveClass}`}
      >
        <ShoppingBasket size={32} />
        {t.grocery}
      </button>
      <button
        type="button"
        onClick={() => onChange('kitchen')}
        className={`${baseClass} ${activeDepartment === 'kitchen' ? activeClass : inactiveClass}`}
      >
        <ChefHat size={32} />
        {t.kitchen}
      </button>
    </div>
  );
}
