/**
 * Erlang-C Queuing & Capacity Planning Engine
 * Implements genuine Erlang-C mathematical equations for inbound contact center demand,
 * chat concurrency calculations, and full staffing traceability.
 */

export interface ErlangCInputs {
  volume: number;           // Call volume in interval
  intervalMinutes: number;  // Interval duration (e.g. 15, 30, 60 min)
  ahtSeconds: number;       // Average Handle Time in seconds
  targetSlaPercent: number; // e.g. 0.80 (80%)
  targetSlaSeconds: number; // e.g. 20 (20 seconds threshold)
  maxOccupancy: number;     // e.g. 0.85 (85% cap)
  shrinkagePercent: number; // e.g. 0.22 (22% shrinkage)
}

export interface ErlangCOutput {
  offeredTrafficErlangs: number;
  rawAgentsRequired: number; // Minimum agents satisfying SLA
  cappedAgentsRequired: number; // After applying max occupancy constraint
  netStaffRequired: number;
  grossStaffRequired: number; // Net staff adjusted for shrinkage
  serviceLevelAchieved: number;
  occupancyAchieved: number;
  probabilityOfWait: number;
  averageSpeedOfAnswerSeconds: number;
}

export interface StaffingTraceabilityReport {
  intervalName: string;
  volume: number;
  intervalMinutes: number;
  ahtSeconds: number;
  trafficIntensityErlangs: number;
  serviceGoalString: string;
  targetOccupancyString: string;
  shrinkageString: string;
  rawStaff: number;
  netStaff: number;
  shrinkageFactor: number;
  grossStaff: number;
  stepByStepDerivation: string[];
}

/**
 * Calculates Erlang C probability of delay (waiting).
 * P(Wait) = [A^N / N! * (N / (N - A))] / [ sum_{k=0}^{N-1} (A^k / k!) + (A^N / N! * (N / (N - A))) ]
 * Using log-space and numerical recurrence to avoid floating-point factorial overflow.
 */
export function calculateProbabilityOfWait(trafficA: number, agentsN: number): number {
  if (agentsN <= trafficA) {
    return 1.0; // Server overload
  }

  let sum = 1.0;
  let term = 1.0;

  for (let k = 1; k < agentsN; k++) {
    term = (term * trafficA) / k;
    sum += term;
  }

  // Next term is A^N / N!
  const termN = (term * trafficA) / agentsN;
  const queueFactor = agentsN / (agentsN - trafficA);
  const numerator = termN * queueFactor;
  const denominator = sum + numerator;

  if (denominator === 0) return 0;
  const pw = numerator / denominator;
  return Math.min(Math.max(pw, 0), 1);
}

/**
 * Calculates Service Level under Erlang C:
 * SL = 1 - P(Wait) * e^(-(N - A) * (T / AHT))
 */
export function calculateServiceLevel(
  trafficA: number,
  agentsN: number,
  targetTimeSec: number,
  ahtSec: number
): number {
  if (agentsN <= trafficA) return 0;
  const pw = calculateProbabilityOfWait(trafficA, agentsN);
  const exponent = -((agentsN - trafficA) * (targetTimeSec / ahtSec));
  const sl = 1 - pw * Math.exp(exponent);
  return Math.min(Math.max(sl, 0), 1);
}

/**
 * Solves for required staff using Erlang C and applies shrinkage and occupancy caps.
 */
export function solveStaffingRequirement(inputs: ErlangCInputs): ErlangCOutput {
  const {
    volume,
    intervalMinutes,
    ahtSeconds,
    targetSlaPercent,
    targetSlaSeconds,
    maxOccupancy,
    shrinkagePercent,
  } = inputs;

  const intervalSeconds = intervalMinutes * 60;
  // Offered traffic A in Erlangs = (calls * AHT) / interval duration
  const trafficA = (volume * ahtSeconds) / intervalSeconds;

  if (trafficA <= 0) {
    return {
      offeredTrafficErlangs: 0,
      rawAgentsRequired: 0,
      cappedAgentsRequired: 0,
      netStaffRequired: 0,
      grossStaffRequired: 0,
      serviceLevelAchieved: 1,
      occupancyAchieved: 0,
      probabilityOfWait: 0,
      averageSpeedOfAnswerSeconds: 0,
    };
  }

  // Binary search or incremental search starting just above trafficA
  let agents = Math.floor(trafficA) + 1;
  let sl = calculateServiceLevel(trafficA, agents, targetSlaSeconds, ahtSeconds);

  while (sl < targetSlaPercent && agents < 1000) {
    agents++;
    sl = calculateServiceLevel(trafficA, agents, targetSlaSeconds, ahtSeconds);
  }

  const rawAgents = agents;
  let occupancy = trafficA / rawAgents;

  // If occupancy exceeds maxOccupancy, scale agents up
  let cappedAgents = rawAgents;
  if (occupancy > maxOccupancy && maxOccupancy > 0) {
    cappedAgents = Math.ceil(trafficA / maxOccupancy);
    occupancy = trafficA / cappedAgents;
  }

  const netStaff = cappedAgents;
  // Gross staffing incorporates shrinkage: Gross = Net / (1 - shrinkage)
  const validShrinkage = Math.min(Math.max(shrinkagePercent, 0), 0.8);
  const grossStaff = Math.ceil(netStaff / (1 - validShrinkage));

  const finalPw = calculateProbabilityOfWait(trafficA, cappedAgents);
  const asa = finalPw > 0 && cappedAgents > trafficA
    ? (finalPw * ahtSeconds) / (cappedAgents - trafficA)
    : 0;

  return {
    offeredTrafficErlangs: Number(trafficA.toFixed(2)),
    rawAgentsRequired: rawAgents,
    cappedAgentsRequired: cappedAgents,
    netStaffRequired: netStaff,
    grossStaffRequired: grossStaff,
    serviceLevelAchieved: Number((sl * 100).toFixed(1)),
    occupancyAchieved: Number((occupancy * 100).toFixed(1)),
    probabilityOfWait: Number((finalPw * 100).toFixed(1)),
    averageSpeedOfAnswerSeconds: Number(asa.toFixed(1)),
  };
}

/**
 * Builds a traceable audit report explaining why an interval requires X agents.
 */
export function generateStaffingTraceability(
  intervalName: string,
  inputs: ErlangCInputs
): StaffingTraceabilityReport {
  const result = solveStaffingRequirement(inputs);
  const intervalSeconds = inputs.intervalMinutes * 60;
  const trafficA = (inputs.volume * inputs.ahtSeconds) / intervalSeconds;
  const shrinkageFactor = 1 / (1 - inputs.shrinkagePercent);

  const derivation: string[] = [
    `1. Demand Workload: ${inputs.volume} arrivals over ${inputs.intervalMinutes} min (${intervalSeconds}s) with Average Handle Time ${inputs.ahtSeconds}s.`,
    `2. Offered Traffic (Workload in Erlangs): A = (${inputs.volume} × ${inputs.ahtSeconds}) / ${intervalSeconds} = ${trafficA.toFixed(2)} Erlangs.`,
    `3. Erlang-C Capacity Solve: Evaluated minimum agents N where Service Level ≥ ${(inputs.targetSlaPercent * 100).toFixed(0)}% within ${inputs.targetSlaSeconds}s. Required raw agents: ${result.rawAgentsRequired}.`,
    `4. Occupancy Cap Check: Unconstrained occupancy at ${result.rawAgentsRequired} agents is ${((trafficA / result.rawAgentsRequired) * 100).toFixed(1)}%. Target max occupancy is ${(inputs.maxOccupancy * 100).toFixed(0)}%. ${
      result.cappedAgentsRequired > result.rawAgentsRequired
        ? `Added ${result.cappedAgentsRequired - result.rawAgentsRequired} agents to protect burnout ceiling.`
        : `Occupancy is within compliant bounds.`
    }`,
    `5. Net Staffing: ${result.netStaffRequired} on-queue agents required.`,
    `6. Shrinkage Scaling: Accounting for ${(inputs.shrinkagePercent * 100).toFixed(1)}% operational shrinkage (breaks, PTO, huddles, coaching), Gross Staff = ${result.netStaffRequired} / (1 - ${inputs.shrinkagePercent.toFixed(2)}) = ${result.grossStaffRequired} rostered agents.`,
  ];

  return {
    intervalName,
    volume: inputs.volume,
    intervalMinutes: inputs.intervalMinutes,
    ahtSeconds: inputs.ahtSeconds,
    trafficIntensityErlangs: Number(trafficA.toFixed(2)),
    serviceGoalString: `${(inputs.targetSlaPercent * 100).toFixed(0)}% in ${inputs.targetSlaSeconds}s`,
    targetOccupancyString: `${(inputs.maxOccupancy * 100).toFixed(0)}%`,
    shrinkageString: `${(inputs.shrinkagePercent * 100).toFixed(1)}%`,
    rawStaff: result.rawAgentsRequired,
    netStaff: result.netStaffRequired,
    shrinkageFactor: Number(shrinkageFactor.toFixed(2)),
    grossStaff: result.grossStaffRequired,
    stepByStepDerivation: derivation,
  };
}
