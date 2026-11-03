/**
 * A new queue has volumes for a few days but not yet enough interval history to know how its day spreads over the hours. It can borrow that
 * pattern from a similar queue: each of its own days is spread the way the other queue's same day was. Its own volume level is never borrowed.
 * Once it has MIN_OWN_DAYS days of its own interval history, its own pattern is used and the borrowing stops by itself.
 */
export const MIN_OWN_DAYS = 28;

export interface SlotRow { day: string; slot: number; volume: number; aht_sec: number }
export interface DayRow { day: string; volume: number; aht_sec: number }

/** Number of distinct days with interval (slot) data. */
export const slotDays = (slots: { day: string }[]) => new Set(slots.map((s) => s.day)).size;

/** Whether the queue should use the other queue's pattern: it has been told to, and its own interval history is still short. */
export const shouldBorrow = (ownSlots: { day: string }[], donorSlots: { day: string }[]) => slotDays(ownSlots) < MIN_OWN_DAYS && slotDays(donorSlots) > slotDays(ownSlots);

/**
 * The queue's interval rows with its few days of its own spread the donor's way: for each day the queue has a total for and the donor has intervals for,
 * the total is spread by the donor's shares for that day, replacing the few noisy intervals of its own. Days the donor has nothing for keep the queue's own
 * intervals. The queue's AHT per day is kept.
 */
export function borrowSlots(ownDaily: DayRow[], ownSlots: SlotRow[], donorSlots: SlotRow[]): { slots: SlotRow[]; borrowedDays: number } {
  const donorByDay = new Map<string, SlotRow[]>();
  for (const s of donorSlots) donorByDay.set(s.day, [...(donorByDay.get(s.day) ?? []), s]);
  const replaced = new Set<string>(), added: SlotRow[] = [];
  for (const d of ownDaily) {
    const rows = donorByDay.get(d.day);
    const total = rows ? rows.reduce((n, r) => n + r.volume, 0) : 0;
    if (!rows || total <= 0 || d.volume <= 0) continue;
    replaced.add(d.day);
    for (const r of rows) if (r.volume > 0) added.push({ day: d.day, slot: r.slot, volume: (d.volume * r.volume) / total, aht_sec: d.aht_sec });
  }
  const borrowed = replaced.size;
  const out = [...ownSlots.filter((s) => !replaced.has(s.day)), ...added];
  out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.slot - b.slot));
  return { slots: out, borrowedDays: borrowed };
}

/** A weekday's share-of-day for each of the 96 slots, from the donor's rows (the same arithmetic the long-range projection uses for a queue's own history). */
export function shareByslot(rows: { slot: number; volume: number }[]): number[] | null {
  const by = new Array(96).fill(0);
  for (const r of rows) if (r.slot >= 0 && r.slot < 96) by[r.slot] += r.volume;
  const total = by.reduce((a, b) => a + b, 0);
  return total > 0 ? by.map((v) => v / total) : null;
}
