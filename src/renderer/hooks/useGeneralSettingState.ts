import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentConfig } from '../../shared/types';

/** Mark user/programmatic edits; config hydration suppresses the marker. */
export function useGeneralSettingState<T>(
  key: keyof AgentConfig,
  initial: T | (() => T),
  markEdited: (key: keyof AgentConfig) => void,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(initial);
  const edit = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    markEdited(key);
    setValue(next);
  }, [key, markEdited]);
  return [value, edit];
}
