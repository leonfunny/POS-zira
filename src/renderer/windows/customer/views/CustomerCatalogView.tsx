import React, { useEffect, useMemo, useState } from 'react';
import { Coffee, Package } from 'lucide-react';
import type { CustomerDisplayCatalogSection } from '../../../../shared/types';
import { resolveName } from '../../../../shared/catalog-names';
import type { Language } from '../../../i18n/translations';
import CustomerDisplayShell from '../components/CustomerDisplayShell';
import { EmptyState } from '../components/CustomerDisplayPrimitives';
import {
  CustomerDisplayServiceCategory,
  formatDisplayCurrency,
} from '../customer-display-model';

interface CustomerCatalogViewProps {
  categories: CustomerDisplayServiceCategory[];
  t: (key: string) => string;
  language: Language;
  businessName?: string;
  onBack: () => void;
  onLanguageChange: (language: Language) => void;
}

const SECTION_ORDER: CustomerDisplayCatalogSection[] = ['retail', 'food'];

function getCategorySection(category: CustomerDisplayServiceCategory): CustomerDisplayCatalogSection {
  return category.section === 'food' ? 'food' : 'retail';
}

function sectionLabel(section: CustomerDisplayCatalogSection, t: (key: string) => string): string {
  return section === 'food'
    ? t('customer.catalog.food')
    : t('customer.catalog.retail');
}

function SectionIcon({ section }: { section: CustomerDisplayCatalogSection }) {
  return section === 'food' ? <Coffee size={22} /> : <Package size={22} />;
}

export default function CustomerCatalogView({
  categories,
  t,
  language,
  businessName,
  onBack,
  onLanguageChange,
}: CustomerCatalogViewProps) {
  const sections = useMemo(
    () => SECTION_ORDER.filter((section) => categories.some((category) => getCategorySection(category) === section)),
    [categories],
  );
  const [selectedSection, setSelectedSection] = useState<CustomerDisplayCatalogSection>(() => sections[0] || 'retail');
  const sectionCategories = useMemo(
    () => categories.filter((category) => getCategorySection(category) === selectedSection),
    [categories, selectedSection],
  );
  const [selectedCategoryId, setSelectedCategoryId] = useState(() => sectionCategories[0]?.id || '');
  const selectedCategory = sectionCategories.find((category) => category.id === selectedCategoryId) || sectionCategories[0] || null;

  useEffect(() => {
    if (!sections.length) return;
    if (!sections.includes(selectedSection)) {
      setSelectedSection(sections[0]);
    }
  }, [sections, selectedSection]);

  useEffect(() => {
    if (!selectedCategoryId || !sectionCategories.some((category) => category.id === selectedCategoryId)) {
      setSelectedCategoryId(sectionCategories[0]?.id || '');
    }
  }, [sectionCategories, selectedCategoryId]);

  return (
    <CustomerDisplayShell
      language={language}
      onLanguageChange={onLanguageChange}
      salonName={businessName}
      title={t('customer.catalog.title')}
      subtitle={sections.length > 1 ? t('customer.catalog.subtitleBoth') : sectionLabel(selectedSection, t)}
      onHome={onBack}
    >
      {!categories.length ? (
        <EmptyState
          title={t('customer.catalog.emptyTitle')}
          description={t('customer.catalog.emptyDesc')}
        />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] gap-5">
          <aside className="flex min-h-0 flex-col gap-4">
            {sections.length > 1 && (
              <div className="grid grid-cols-2 gap-2">
                {sections.map((section) => (
                  <button
                    key={section}
                    type="button"
                    onClick={() => {
                      setSelectedSection(section);
                      const firstCategory = categories.find((category) => getCategorySection(category) === section);
                      setSelectedCategoryId(firstCategory?.id || '');
                    }}
                    className={`flex min-h-[68px] items-center justify-center gap-2 rounded-lg border px-3 text-lg font-semibold transition-colors ${
                      selectedSection === section
                        ? 'border-brand-300 bg-brand-50 text-brand-700'
                        : 'border-slate-200 bg-white text-slate-600'
                    }`}
                    data-customer-display-catalog-section={section}
                  >
                    <SectionIcon section={section} />
                    <span>{sectionLabel(section, t)}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-sm">
              {sectionCategories.map((category) => {
                const active = category.id === selectedCategory?.id;
                return (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => setSelectedCategoryId(category.id)}
                    className={`mb-2 flex w-full items-center justify-between gap-3 rounded-md px-4 py-4 text-left transition-colors last:mb-0 ${
                      active
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span className="min-w-0 truncate text-lg font-semibold">
                      {resolveName(category, language)}
                    </span>
                    <span className={`shrink-0 rounded px-2 py-1 text-sm font-semibold ${active ? 'bg-white/20 text-white' : 'bg-white text-slate-500'}`}>
                      {category.services.length}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="flex min-h-0 flex-col rounded-lg border border-slate-200 bg-white shadow-sm">
            <header className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {sectionLabel(selectedSection, t)}
                </div>
                <h2 className="mt-1 truncate text-3xl font-semibold text-slate-950">
                  {selectedCategory ? resolveName(selectedCategory, language) : t('customer.catalog.title')}
                </h2>
              </div>
              <div className="rounded-md bg-slate-100 px-3 py-2 text-base font-semibold text-slate-600">
                {selectedCategory?.services.length || 0} {t('customer.catalog.items')}
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-5" data-customer-display-catalog-grid="true">
              {!selectedCategory ? (
                <EmptyState title={t('customer.catalog.emptyTitle')} />
              ) : (
                <div className="grid grid-cols-3 gap-4 xl:grid-cols-4">
                  {selectedCategory.services.map((item) => (
                    <div
                      key={item.id}
                      className="flex min-h-[210px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
                      data-customer-display-catalog-item="true"
                    >
                      <div className="flex h-24 items-center justify-center bg-white">
                        {item.imageUrl ? (
                          <img src={item.imageUrl} alt="" className="h-full w-full object-contain" />
                        ) : (
                          <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-slate-100 text-slate-400">
                            <SectionIcon section={selectedSection} />
                          </div>
                        )}
                      </div>
                      <div className="flex min-h-0 flex-1 flex-col p-4">
                        <div className="line-clamp-2 min-h-[56px] text-xl font-semibold leading-7 text-slate-950">
                          {resolveName(item, language)}
                        </div>
                        <div className="mt-auto flex items-end justify-between gap-3 pt-4">
                          <span className="text-2xl font-bold tabular-nums text-brand-700">
                            {formatDisplayCurrency(item.price, language)}
                          </span>
                          {item.saleUnit && (
                            <span className="rounded bg-white px-2 py-1 text-sm font-semibold text-slate-500">
                              {item.saleUnit}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </CustomerDisplayShell>
  );
}
