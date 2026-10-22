/** DTO shapes mirrored from the gateway's /me/* routes (see backend/gateway/src/modules/selfService.ts, swaps.ts, offers/routes.ts, bids/routes.ts). */

export type Activity = { type: string; startTime: string; endTime: string; startSlot: number; slots: number; color: string };
export type Shift = {
  id: string; day: string; startTime: string; endTime: string; overnight: boolean; startSlot: number; lengthSlots: number; paidHours: number;
  template: string | null; schedule: string; versionId: string; activities: Activity[]; color: string;
};
export type DaySummary = { day: string; shift: Shift | null; published: boolean; timeOff: { id: string; type: string; status: string } | null; swap: { id: string; status: string; kind: string } | null };

export type Profile = {
  employeeId: string; name: string; employeeNumber: string; email: string | null; phone: string | null; extension: string | null; team: string | null; group: string | null;
  timezone: string; employmentType: string; weeklyContractHours: number; nightShiftConsent: boolean; skills: { name: string; proficiency: number }[]; today: string;
};

export type Home = {
  name: string; today: string; timezone: string; todayShift: Shift | null; nextShift: Shift | null; publishedToday: boolean; weekHours: number; unreadNotifications: number;
  pendingTimeOff: number; swapsIncoming: number; swapsMine: number; boardOpen: number; offersOpen: number;
};

export type Notification = { id: number; kind: string; title: string; body: string; data: { screen?: string; id?: string }; createdAt: string; read: boolean };

export type TimeOffType = 'VACATION' | 'SICK' | 'PERSONAL' | 'HOLIDAY' | 'TRAINING' | 'LEAVE' | 'OTHER';
export type TimeOff = {
  id: string; type: TimeOffType; startDate: string; endDate: string; days: number; status: string; reason: string | null;
  decidedBy: string | null; decidedAt: string | null; autoDecided: boolean; decisionNote: string | null; createdAt: string;
};
export type TimeOffBalance = { type: TimeOffType; entitledDays: number; usedDays: number; remainingDays: number };
export type TimeOffRules = { autoApprove: boolean; minNoticeDays: number; maxOffPercent: number };
export type TimeOffCheck = { days: number; blockers: string[]; willBeApprovedAutomatically: boolean; reasonsForReview: string[] };

export type AvailabilityKind = 'AVAILABLE' | 'UNAVAILABLE' | 'PREFERRED';
export type AvailabilityWindow = { dayOfWeek: number; startTime: string; endTime: string; kind: AvailabilityKind };

export type SwapStatus = 'OPEN' | 'PENDING_PARTNER' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
export type Swap = {
  id: string; kind: 'SWAP' | 'GIVEAWAY'; status: SwapStatus; note: string | null; versionId: string; versionName: string;
  requesterId: string; requesterName: string; partnerId: string | null; partnerName: string | null;
  give: { shiftId: string; day: string; startTime: string; endTime: string }; get: { shiftId: string; day: string; startTime: string; endTime: string } | null;
  decisionReason: string | null; decidedBy: string | null; decidedAt: string | null; autoApproved: boolean; checks: unknown; expiresAt: string | null; createdAt: string; updatedAt: string;
};
export type SwapCandidate = {
  shiftId: string; employeeId: string; name: string; day: string; startTime: string; endTime: string;
  verdict: { ok: boolean; auto: boolean; blockers: string[]; warnings: string[]; extraGapSlots: number; coverageBefore: number; coverageAfter: number };
};

export type OfferStatus = 'QUEUED' | 'INVITED' | 'ACCEPTED' | 'DECLINED' | 'SKIPPED' | 'EXPIRED';
export type Offer = {
  id: string; groupId: string; kind: 'VTO' | 'OVERTIME'; day: string; startTime: string; endTime: string; note: string | null;
  spots: number; filled: number; status: string; closesAt: string | null; createdBy: string; createdAt: string; spotsLeft: number; myStatus: OfferStatus; warnings: string[]; respondedAt: string | null;
};

/** What the Schedule day-detail panel hands off when the person wants to act on a specific day -- carried through
    App -> Requests -> the relevant sub-tab, which pre-fills its form from it instead of starting blank. */
export type RequestPrefill = { tab: 'timeoff'; date: string } | { tab: 'swaps'; shiftId: string };

export type BidPattern = { id: string; name: string; days: string[]; startTime: string; endTime: string; overnight: boolean; paidHours: number; capacity: number; templateName: string | null; fits: boolean; why: string };
export type Bid = {
  id: string; groupId: string; groupName: string; name: string; status: 'OPEN' | 'CLOSED' | 'AWARDED'; method: string; periodStart: string; weeks: number; closesAt: string | null;
  patterns: BidPattern[]; myRanking: string[]; myAward: { patternId: string; patternName: string; rank: number } | null;
};
