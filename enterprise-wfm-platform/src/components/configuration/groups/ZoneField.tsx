/** The time zone of a WFM group: a searchable list, the time it is there now, and a caution when it looks wrong for the group's site. */
import React from 'react';
import { ZoneSelect } from '../../common/ZoneSelect';
import { localTime, zoneNote } from '../../../services/timeZones';

export const ZoneField: React.FC<{ value: string; onChange: (zone: string, byPerson: boolean) => void; siteZone?: string | null; siteName?: string | null; orgZone?: string | null }> = ({ value, onChange, siteZone, siteName, orgZone }) => {
  const now = new Date();
  const note = zoneNote({ zone: value, siteZone, siteName, orgZone });
  const there = localTime(value, now);
  return (
    <div className="space-y-1">
      <ZoneSelect value={value} onChange={(z) => onChange(z, true)} />
      <div className="text-[12px] text-[#6B6B6B]">{there ? `Now ${there} there` : ''}{siteZone && value === siteZone ? `${there ? ' · ' : ''}same as the site` : ''}</div>
      {note.kind === 'check' && (
        <div className="text-[12px] text-[#8F6200]" role="status">
          {note.text}{note.suggest && <> <button type="button" className="underline font-medium" onClick={() => onChange(note.suggest!, true)}>Use {note.suggest}</button></>}
        </div>
      )}
    </div>
  );
};
