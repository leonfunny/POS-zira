import React from 'react';

interface StaffMember {
  id: string;
  name: string;
  commission_rate: number;
}

interface StaffPickerProps {
  staffList: StaffMember[];
  selectedStaffId: string | null;
  onSelect: (staffId: string, staffName: string) => void;
  t: (key: string) => string;
}

export default function StaffPicker({ staffList, selectedStaffId, onSelect, t }: StaffPickerProps) {
  return (
    <div className="mt-1.5">
      <select
        value={selectedStaffId || ''}
        onChange={(e) => {
          const staff = staffList.find((s) => s.id === e.target.value);
          if (staff) onSelect(staff.id, staff.name);
        }}
        className="w-full px-3 py-2 text-xs bg-slate-700/80 border border-slate-600/60 rounded-lg text-slate-300 appearance-none cursor-pointer hover:bg-slate-600 transition-colors focus:outline-none focus:border-brand-500/50"
      >
        <option value="">{t('pos.salon.noStaff')}</option>
        {staffList.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} ({(s.commission_rate / 100).toFixed(0)}%)
          </option>
        ))}
      </select>
    </div>
  );
}
