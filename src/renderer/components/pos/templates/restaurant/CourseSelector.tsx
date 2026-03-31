import React from 'react';

interface CourseSelectorProps {
  activeCourse: number;
  onChange: (course: number) => void;
  t: (key: string) => string;
}

const COURSES = [
  { value: 1, key: 'pos.restaurant.starter' },
  { value: 2, key: 'pos.restaurant.main' },
  { value: 3, key: 'pos.restaurant.dessert' },
  { value: 4, key: 'pos.restaurant.drinks' },
];

export default function CourseSelector({ activeCourse, onChange, t }: CourseSelectorProps) {
  return (
    <div className="p-2 border-t border-slate-700">
      <h3 className="text-xs font-medium text-slate-500 mb-1">{t('pos.restaurant.course')}</h3>
      <div className="grid grid-cols-2 gap-1">
        {COURSES.map((c) => (
          <button
            key={c.value}
            onClick={() => onChange(c.value)}
            className={`
              px-2 py-1 text-xs rounded transition-colors
              ${activeCourse === c.value
                ? 'bg-purple-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }
            `}
          >
            {t(c.key)}
          </button>
        ))}
      </div>
    </div>
  );
}
