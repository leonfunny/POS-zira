type SyntheticGlobals = { label: string };

export function readSyntheticGlobals(
  globalThis: SyntheticGlobals,
  self: SyntheticGlobals,
  window: SyntheticGlobals,
): string[] {
  const runtime = globalThis;
  return [runtime.label, self.label, window.label];
}
