/**
 * Choose a time zone: searchable by city or country ("kenya", "india", "new york"), the common zones first, then every zone in the IANA database by region. Each row reads
 * "Nairobi, Kenya (UTC+3)" with the time it is there now. A zone saved under an old name (Asia/Calcutta) is shown under its current name (Kolkata).
 */
import React, { useMemo } from 'react';
import { Combobox } from './Combobox';
import { canonicalZone, zoneList } from '../../services/timeZones';
import type { ComboGroup } from '../../services/comboFilter';

const COMMON = ['UTC', 'Africa/Nairobi', 'Africa/Lagos', 'Africa/Johannesburg', 'Africa/Cairo', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Manila', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto'];

export const ZoneSelect: React.FC<{ value: string; onChange: (zone: string) => void; id?: string; disabled?: boolean; className?: string }> = ({ value, onChange, id, disabled, className }) => {
  const current = canonicalZone(value);
  const groups = useMemo<ComboGroup[]>(() => {
    const all = zoneList(new Date());
    const item = (z: (typeof all)[number]) => ({ value: z.id, label: z.label, right: z.time, keywords: `${z.id} ${z.region} ${z.city} ${z.countryName} ${z.country}` });
    const known = new Set(all.map((z) => z.id));
    const common = COMMON.map((c) => all.find((z) => z.id === c)).filter(Boolean) as typeof all;
    const regions = [...new Set(all.filter((z) => z.id !== 'UTC').map((z) => z.region))];
    return [
      ...(current && !known.has(current) ? [{ label: 'Current', items: [{ value: current, label: current, keywords: current }] }] : []),
      { label: 'Common', items: common.map(item) },
      ...regions.map((r) => ({ label: r, items: all.filter((z) => z.region === r && z.id !== 'UTC').map(item) })),
    ];
  }, [current]);
  return <Combobox id={id} value={current} onChange={onChange} groups={groups} ariaLabel="Time zone" disabled={disabled} searchPlaceholder="Search a city or country…" className={className} />;
};
