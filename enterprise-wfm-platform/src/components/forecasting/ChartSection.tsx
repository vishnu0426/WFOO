/**
 * A chart that is only worth drawing when it shows something. When the data is flat or empty (a handle time that is 180 s all day, a requirement with no schedule to set it against) the
 * section is one line saying what the chart would have said, with a button to draw it anyway. Charts that have something to show are drawn as before.
 */
import React, { useEffect, useState } from 'react';
import { Section } from '../wfm/app-shell';

export function ChartSection({ title, quiet, summary, action, children }: { title: React.ReactNode; quiet: boolean; summary: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { setShown(false); }, [quiet]);          // a new range may make it worth drawing (or not): start from the one-line summary again
  if (quiet && !shown) {
    return (
      <Section title={title}>
        <div className="flex flex-wrap items-center gap-3 px-6 pb-4 text-[13px] text-muted-foreground">
          <p role="status">{summary}</p>
          <button type="button" onClick={() => setShown(true)} className="h-8 shrink-0 rounded-md border bg-background px-3 font-medium text-foreground hover:bg-surface">Show chart</button>
        </div>
      </Section>
    );
  }
  return (
    <Section title={title} action={quiet ? <button type="button" onClick={() => setShown(false)} className="text-[12px] underline text-muted-foreground">Hide chart</button> : action}>
      {children}
    </Section>
  );
}
