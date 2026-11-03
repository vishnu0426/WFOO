/**
 * Date formatters for a time zone, built once. Constructing an Intl.DateTimeFormat costs tens of microseconds and holds native (non-heap) memory, and the
 * schedule, payroll and adherence code asks about the same few zones millions of times: building one per question made them slow and, at 6,000 agents,
 * used up native memory until the process was killed without a log line.
 */
const cache = new Map<string, Intl.DateTimeFormat>();

export function tzFmt(locale: string, timeZone: string, opts: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone, ...opts });
    if (cache.size > 500) cache.clear();           // zones come from settings, so this is only a guard against a runaway caller
    cache.set(key, f);
  }
  return f;
}
