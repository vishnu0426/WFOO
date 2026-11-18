/** Which shift templates the solver used for a schedule and, for each one it did not, why. A template that was never chosen although its hours are short is marked first. */
import React from 'react';
import { TemplateUse } from '../../services/api';
import { Pill, Table } from '../forecasting/ui';

const TONE: Record<TemplateUse['status'], 'good' | 'warn' | 'neutral'> = { USED: 'good', UNUSED_SHORT: 'warn', UNUSED: 'neutral' };
const LABEL: Record<TemplateUse['status'], string> = { USED: 'Used', UNUSED_SHORT: 'Not used, hours short', UNUSED: 'Not needed' };
const ORDER: Record<TemplateUse['status'], number> = { UNUSED_SHORT: 0, USED: 1, UNUSED: 2 };

export const TemplatesUsed: React.FC<{ rows: TemplateUse[] }> = ({ rows }) => {
  const list = [...rows].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.shifts - a.shifts || a.name.localeCompare(b.name));
  return (
    <div className="space-y-1.5" data-testid="templates-used">
      <div className="text-[13px] font-semibold">Shift templates used</div>
      <div className="overflow-x-auto">
        <Table head={['Template', 'Shifts', 'People', 'Offered', 'Short in its hours', 'Result']} right={[1, 2, 3, 4]}>
          {list.map((t) => (
            <React.Fragment key={t.id}>
              <tr>
                <td className="p-3 font-medium">{t.name}</td>
                <td className="p-3 text-right tabular-nums">{t.shifts.toLocaleString('en-US')}</td>
                <td className="p-3 text-right tabular-nums">{t.people.toLocaleString('en-US')}</td>
                <td className="p-3 text-right tabular-nums">{t.offered.toLocaleString('en-US')}</td>
                <td className="p-3 text-right tabular-nums">{t.shortHours ? `${t.shortHours.toLocaleString('en-US')} h` : '–'}</td>
                <td className="p-3"><Pill tone={TONE[t.status]}>{LABEL[t.status]}</Pill></td>
              </tr>
              {t.reason && <tr><td colSpan={6} className="px-3 pb-3 pt-0 text-[12px] text-[#525252]">{t.reason}</td></tr>}
            </React.Fragment>
          ))}
        </Table>
      </div>
    </div>
  );
};
