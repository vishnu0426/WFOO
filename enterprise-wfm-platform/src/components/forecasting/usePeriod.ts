import { useCallback, useState } from "react";
import { PERIOD_KEY, readWeeks } from "../../services/periods";

/** The look-back period (in weeks), remembered and shared by every screen that offers one. */
export function usePeriod(): [number, (weeks: number) => void] {
  const [weeks, set] = useState(() => readWeeks(localStorage.getItem(PERIOD_KEY)));
  const setWeeks = useCallback((w: number) => { set(w); localStorage.setItem(PERIOD_KEY, String(w)); }, []);
  return [weeks, setWeeks];
}
