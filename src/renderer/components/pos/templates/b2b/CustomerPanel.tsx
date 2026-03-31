import React, { useState } from 'react';

interface B2BCustomer {
  id: string;
  name: string;
  nip: string | null;
  email: string | null;
  phone: string | null;
  credit_limit: number;
  current_debt: number;
  payment_terms: number;
}

interface CustomerPanelProps {
  customers: B2BCustomer[];
  selectedCustomer: B2BCustomer | null;
  onSelectCustomer: (customer: B2BCustomer | null) => void;
  t: (key: string) => string;
}

export default function CustomerPanel({ customers, selectedCustomer, onSelectCustomer, t }: CustomerPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);

  const filtered = searchQuery
    ? customers.filter(
        (c) =>
          c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (c.nip && c.nip.includes(searchQuery)),
      )
    : customers;

  return (
    <div className="px-4 py-2 border-b border-slate-700 bg-slate-800/50 flex items-center gap-3 shrink-0 relative">
      <span className="text-xs text-slate-400 shrink-0">{t('pos.b2b.selectCustomer')}:</span>
      <div className="relative flex-1 max-w-sm">
        <input
          type="text"
          value={selectedCustomer ? selectedCustomer.name : searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setShowDropdown(true);
          }}
          onFocus={() => {
            setShowDropdown(true);
            if (selectedCustomer) {
              setSearchQuery('');
            }
          }}
          placeholder={t('pos.b2b.selectCustomer')}
          className="w-full px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-white placeholder-slate-500"
        />
        {showDropdown && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-slate-700 border border-slate-600 rounded shadow-lg z-50 max-h-48 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-2 text-sm text-slate-400 text-center">-</div>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    onSelectCustomer(c);
                    setShowDropdown(false);
                    setSearchQuery('');
                  }}
                  className="w-full px-3 py-2 text-left hover:bg-slate-600 transition-colors text-sm flex justify-between"
                >
                  <span>{c.name}</span>
                  {c.nip && <span className="text-xs text-slate-400">{c.nip}</span>}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {selectedCustomer && (
        <button
          onClick={() => {
            onSelectCustomer(null);
            setSearchQuery('');
          }}
          className="text-xs text-slate-400 hover:text-red-400"
        >
          x
        </button>
      )}
    </div>
  );
}
