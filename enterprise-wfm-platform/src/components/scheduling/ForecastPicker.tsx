/**
 * Generate Schedule › "Forecast to follow". A panel that says what each forecast is, instead of a plain dropdown of all of them: Automatic first (and exactly which forecast it will use), then the
 * published forecasts that reach the schedule's dates, with only what is unusual about each one. Forecasts that are not published yet, and those that miss the dates, are tucked behind one line
 * ("6 more hidden · Show"); archived ones behind another. A forecast that is already chosen is never hidden. Arrow keys, Enter and Escape work.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Pill } from '../forecasting/ui';
import { accuracyText, autoLine, autoShort, coverText, forecastTitle, hasOwnName, monthDay, pickerView, shortSpan, statusText, type ForecastChoice, type FvAccuracy } from '../../services/liveForecasts';

const STATE_TONE: Record<string, 'good' | 'warn' | 'info' | 'neutral'> = { PUBLISHED: 'good', DRAFT: 'warn', SUBMITTED: 'warn', APPROVED: 'info', ARCHIVED: 'neutral' };
type Section = 'USABLE' | 'UNAPPROVED' | 'ARCHIVED' | 'NONE';

/** The round marker at the left of an option: filled when it is the one chosen. */
const Radio: React.FC<{ on: boolean }> = ({ on }) => (
  <span aria-hidden className={`mt-0.5 shrink-0 w-4 h-4 rounded-full border flex items-center justify-center ${on ? 'border-[#171717]' : 'border-[#C9C9C2]'}`}>{on && <span className="w-2 h-2 rounded-full bg-[#171717]" />}</span>
);

export const ForecastPicker: React.FC<{
  value: string; onChange: (id: string) => void; choices: ForecastChoice[]; accuracy: Record<string, FvAccuracy>; yearOf: number;
  /** "show everything": forecasts not published yet, and those that do not reach the dates */
  showUnapproved: boolean; onShowUnapproved: (on: boolean) => void; showOld: boolean; onShowOld: (on: boolean) => void;
  /** the forecasts are still loading, or could not be loaded: said instead of "no forecast reaches these dates" */
  state?: 'loading' | 'error' | null;
  /** start with the panel open (used to test what it shows) */
  defaultOpen?: boolean;
}> = ({ state = null, defaultOpen = false, value, onChange, choices, accuracy, yearOf, showUnapproved, onShowUnapproved, showOld, onShowOld }) => {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const view = useMemo(() => pickerView(choices, { showUnapproved, chosenId: value === 'AUTO' ? null : value }), [choices, showUnapproved, value]);
  const chosen = value === 'AUTO' ? null : choices.find((c) => c.fv.id === value) ?? null;
  const trigger = () => root.current?.querySelector('button[aria-haspopup]') as HTMLElement | null;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => { if (open) (panel.current?.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus(); }, [open]);

  const pick = (id: string) => { onChange(id); setOpen(false); trigger()?.focus(); };
  const move = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); trigger()?.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(panel.current?.querySelectorAll('[role="option"], [data-step]') ?? [])] as HTMLElement[];
    const at = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  /** One forecast. Inside "Can be used" every forecast is live and reaches the dates, so only what is unusual is said: a part cover, the one Automatic uses, and how it compares. */
  const row = (c: ForecastChoice, section: Section) => {
    const f = c.fv as ForecastChoice['fv'] & { publishedBy?: string | null };
    const isAuto = view.auto?.fv.id === f.id;
    const prefers = !isAuto && view.auto && c.live && f.publishedAt && view.auto.fv.publishedAt && f.publishedAt < view.auto.fv.publishedAt ? `Automatic prefers ${forecastTitle(view.auto.fv)} for these dates` : null;
    const published = f.publishedAt ? `published ${monthDay(f.publishedAt.slice(0, 10), yearOf)}${f.publishedBy ? ` by ${f.publishedBy}` : ''}` : null;
    const name = forecastTitle(f);
    return (
      <button key={f.id} type="button" role="option" aria-selected={value === f.id} onClick={() => pick(f.id)} className={`w-full text-left px-3 py-2 flex items-start gap-2.5 hover:bg-[#FAFAF8] focus:bg-[#FAFAF8] focus:outline-none ${value === f.id ? 'bg-[#F3F3EF]' : ''}`}>
        <Radio on={value === f.id} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="text-[13px] font-semibold text-[#171717] truncate" title={name}>{name}</span>
            {hasOwnName(f) && <span className="text-[11px] text-[#6B6B6B] shrink-0">v{f.seq}</span>}
            {section !== 'USABLE' && <Pill tone={STATE_TONE[f.status] ?? 'neutral'}>{statusText(f)}</Pill>}
            {(section !== 'USABLE' || c.covers !== 'ALL') && <Pill tone={c.covers === 'ALL' ? 'good' : c.covers === 'PART' ? 'warn' : 'neutral'}>{coverText(c)}</Pill>}
            {isAuto && <Pill tone="info">Automatic uses this</Pill>}
          </span>
          <span className="block text-[12px] text-[#525252] mt-0.5">
            {shortSpan(f.fromDay, f.toDay, yearOf)}{published ? ` · ${published}` : ''}{prefers ? ` · ${prefers}` : ''}
            {(section === 'USABLE' || section === 'ARCHIVED') && <span className="text-[#6B6B6B]"> · {accuracyText(accuracy[f.id])}</span>}
          </span>
          {section === 'UNAPPROVED' && <span className="block text-[12px] text-[#8F6200] mt-0.5">Not approved: fine for a trial schedule, not for one that goes to people.</span>}
        </span>
      </button>
    );
  };
  const head = (text: string) => <div className="px-3 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[#6B6B6B] bg-white sticky top-0">{text}</div>;

  const hidden = view.hiddenUnapproved + view.hiddenNone;
  const hiddenWhat = [view.hiddenUnapproved ? `${view.hiddenUnapproved} not published yet` : '', view.hiddenNone ? `${view.hiddenNone} that ${view.hiddenNone === 1 ? 'does' : 'do'} not reach these dates` : ''].filter(Boolean).join(', ');
  const step = 'underline text-[#171717] hover:no-underline focus:outline-none focus:ring-1 focus:ring-[#171717] rounded-sm';
  return (
    <div ref={root} className="relative" onKeyDown={open ? move : undefined}>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-label="Forecast to follow" onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 text-left border border-[#E5E5E0] rounded-md bg-white px-3 py-2 hover:bg-[#FAFAF8]">
        <span className="min-w-0 block truncate text-[13px]">
          {chosen ? (
            <>
              <span className="font-semibold">{forecastTitle(chosen.fv)}</span>{hasOwnName(chosen.fv) && <span className="text-[11px] text-[#6B6B6B]"> v{chosen.fv.seq}</span>}
              <span className="text-[#525252]"> · {statusText(chosen.fv)} · {coverText(chosen).toLowerCase()} · {shortSpan(chosen.fv.fromDay, chosen.fv.toDay, yearOf)}</span>
            </>
          ) : (
            <>
              <span className="font-semibold">Automatic</span> <span className="text-[#6B6B6B]">(recommended)</span>
              <span className="text-[#525252]"> · {state === 'loading' ? 'Loading the forecasts…' : state === 'error' ? 'The forecasts could not be loaded. Reload the page to try again.' : autoShort(choices, yearOf)}</span>
            </>
          )}
        </span>
        <ChevronDown className={`w-4 h-4 shrink-0 text-[#6B6B6B] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div ref={panel} role="listbox" aria-label="Forecasts" className="absolute z-30 mt-1 w-full max-h-104 overflow-y-auto rounded-md border border-[#E5E5E0] bg-white shadow-lg divide-y divide-[#F0F0EC]">
          <button type="button" role="option" aria-selected={value === 'AUTO'} onClick={() => pick('AUTO')} className={`w-full text-left px-3 py-2 flex items-start gap-2.5 hover:bg-[#FAFAF8] focus:bg-[#FAFAF8] focus:outline-none ${value === 'AUTO' ? 'bg-[#F3F3EF]' : ''}`}>
            <Radio on={value === 'AUTO'} />
            <span>
              <span className="block text-[13px] font-semibold text-[#171717]">Automatic <span className="font-normal text-[#6B6B6B]">(recommended)</span></span>
              <span className="block text-[12px] text-[#525252] mt-0.5">{state === 'loading' ? 'Loading the forecasts…' : state === 'error' ? 'The forecasts could not be loaded.' : autoLine(choices, yearOf)}</span>
            </span>
          </button>

          <div>
            {head('Can be used for this schedule')}
            {view.usable.length === 0 ? <p className="px-3 pb-2 text-[12px] text-[#6B6B6B]">{state === 'loading' ? 'Loading…' : state === 'error' ? 'Could not load the forecasts.' : 'No published forecast reaches these dates.'}</p> : view.usable.map((c) => row(c, 'USABLE'))}
          </div>

          {view.unapproved.length > 0 && <div>{head('Not published yet')}{view.unapproved.map((c) => row(c, 'UNAPPROVED'))}</div>}
          {view.archived.length > 0 && <div>{head('Older, archived')}{view.archived.map((c) => row(c, 'ARCHIVED'))}</div>}
          {view.none.length > 0 && <div>{head('Do not reach these dates')}{view.none.map((c) => row(c, 'NONE'))}</div>}

          <div className="px-3 py-2 space-y-1 bg-[#FAFAF8] text-[12px] text-[#525252]">
            {hidden > 0 && <p>{hidden} more {hidden === 1 ? 'forecast is' : 'forecasts are'} hidden: {hiddenWhat}. <button type="button" data-step className={step} onClick={() => onShowUnapproved(true)}>Show</button></p>}
            {showUnapproved && <p><button type="button" data-step className={step} onClick={() => onShowUnapproved(false)}>Hide forecasts that are not published or do not reach these dates</button></p>}
            <p><button type="button" data-step className={step} onClick={() => onShowOld(!showOld)}>{showOld ? 'Hide older, archived forecasts' : 'Show older, archived forecasts'}</button></p>
            <p className="text-[11px] text-[#6B6B6B]">Where two live forecasts overlap, the one published last is used.</p>
          </div>
        </div>)}
    </div>
  );
};
