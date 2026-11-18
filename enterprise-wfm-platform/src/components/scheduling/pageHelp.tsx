/** "How this works" panels for the Scheduling screens. */
import React from 'react';
import { HelpSection, PageHelp } from '../common/HelpTip';

const P: Record<string, { title: string; body: React.ReactNode }> = {
  'generate-schedule': {
    title: 'How schedules are built',
    body: (
      <>
        <HelpSection title="What it does">
          <p>Builds a draft roster for one WFM group from the published forecast. Nothing changes for people until you publish the draft.</p>
        </HelpSection>
        <HelpSection title="What you choose">
          <p><b>Dates and pay week:</b> the period to cover and the day the pay week starts, which sets where weekly limits and overtime are counted.</p>
          <p><b>How to build:</b> follow a rotation pattern, fill around one, or let the builder decide everything.</p>
          <p><b>How sure to be:</b> a higher setting plans for a busier day than the forecast.</p>
        </HelpSection>
        <HelpSection title="What is always respected">
          <p>One shift a day, rest between shifts, weekly maximums, days in a row, days off together and weekends off in a month (when set), availability, approved time off and weekends-off requests, and template days.</p>
        </HelpSection>
        <HelpSection title="After it runs">
          <p>The result shows coverage, any shortage by day and skill, and a quality score. Open Schedule Quality for the detail.</p>
        </HelpSection>
      </>
    ),
  },
  rotations: {
    title: 'How rotation patterns work',
    body: (
      <>
        <HelpSection title="What a pattern is">
          <p>A repeating cycle of work days and days off, such as 4 on and 3 off. People on a pattern keep the same rhythm week after week.</p>
        </HelpSection>
        <HelpSection title="Using one">
          <p>Pick a ready-made pattern or build your own, check it against the labour-law pack, then add the people who follow it, with the date it starts and where in the cycle they begin.</p>
        </HelpSection>
        <HelpSection title="The checks">
          <p>The legal check uses the pack that applies to the group. The fairness check shows how evenly weekends and nights are shared across the cycle.</p>
        </HelpSection>
      </>
    ),
  },
  'year-plan': {
    title: 'How the year plan works',
    body: (
      <>
        <HelpSection title="What it shows">
          <p>A long schedule week by week: how well each week is covered, which weeks are locked and which are still planned.</p>
        </HelpSection>
        <HelpSection title="Locked and planned weeks">
          <p>Weeks close to today are solved shift by shift and locked. Weeks far ahead repeat the last solved cycle and are solved again as they come closer.</p>
        </HelpSection>
      </>
    ),
  },
  'schedule-quality': {
    title: 'How to read schedule quality',
    body: (
      <>
        <HelpSection title="The score">
          <p>A single number for how well a schedule covers demand and respects people. The cards below it explain what pulled it down.</p>
        </HelpSection>
        <HelpSection title="Shortages">
          <p>Shows where there are too few people, by day, hour and skill, and where there are too many.</p>
        </HelpSection>
        <HelpSection title="Generation report">
          <p>What happened when the schedule was built: which method answered, how long it took and any warnings.</p>
        </HelpSection>
      </>
    ),
  },
  'shift-bidding': {
    title: 'How shift bidding works',
    body: (
      <>
        <HelpSection title="The steps">
          <p>Offer weekly patterns, let people rank them, decide the result fairly, then build a draft schedule from the outcome.</p>
        </HelpSection>
        <HelpSection title="Fairness">
          <p>When several people want the same pattern, the method you choose decides who gets it: seniority, lottery, or the best overall outcome.</p>
        </HelpSection>
      </>
    ),
  },
};

export const schedulingHelp = (key: string): React.ReactNode => {
  const h = P[key];
  return h ? <PageHelp title={h.title}>{h.body}</PageHelp> : undefined;
};
