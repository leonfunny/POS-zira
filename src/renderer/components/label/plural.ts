/**
 * Polish, Ukrainian and Russian count in three shapes, not two: one kolor,
 * two/three/four kolory, five kolorów — with the teens taking the last shape
 * however they end. The panel used the 5+ shape for everything, so the workshop
 * read "2 kolorów" and "2 warianty" came out wrong all day.
 *
 * Polish and East Slavic agree on the teens and on 2–4, but part ways at 21:
 * Polish says "21 kolorów" (the many shape), Russian and Ukrainian say
 * "21 цвет" (the one shape). Hence two helpers, not one.
 */

/** Polish: 1 → one; 2–4 outside the teens → few; everything else → many. */
export function plForm(count: number, one: string, few: string, many: string): string {
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  if (count === 1) return one;
  if (lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14)) return few;
  return many;
}

/** Ukrainian and Russian: any …1 outside the teens → one; …2–4 → few; else many. */
export function eastSlavicForm(count: number, one: string, few: string, many: string): string {
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (lastDigit === 1) return one;
  if (lastDigit >= 2 && lastDigit <= 4) return few;
  return many;
}
