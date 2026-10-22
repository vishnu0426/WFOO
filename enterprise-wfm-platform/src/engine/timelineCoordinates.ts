/**
 * Unified Deterministic Timeline Projection Engine
 * Powers the Schedule Timeline, Staffing Heatmap, Coverage overlays, Drag-and-drop, and Resizing.
 * Guarantees pixel-perfect X-axis synchronization across all visual layers.
 */

export type ZoomLevel = '15m' | '30m' | '1h' | '2h';

export interface TimelineDimensions {
  startHour: number; // e.g. 7 (07:00)
  endHour: number;   // e.g. 21 (21:00)
  totalHours: number;
  pixelsPerHour: number;
  totalWidth: number;
  zoomLevel: ZoomLevel;
  snapMinutes: 15 | 30;
}

export const ZOOM_CONFIGS: Record<ZoomLevel, { pixelsPerHour: number; snapMinutes: 15 | 30; stepMinutes: number }> = {
  '15m': { pixelsPerHour: 140, snapMinutes: 15, stepMinutes: 15 },
  '30m': { pixelsPerHour: 90, snapMinutes: 30, stepMinutes: 30 },
  '1h': { pixelsPerHour: 55, snapMinutes: 30, stepMinutes: 60 },
  '2h': { pixelsPerHour: 36, snapMinutes: 30, stepMinutes: 120 },
};

/**
 * Returns timeline bounds and metrics for a given operating window and zoom.
 */
export function getTimelineDimensions(
  startHour = 6,
  endHour = 22,
  zoomLevel: ZoomLevel = '30m'
): TimelineDimensions {
  const config = ZOOM_CONFIGS[zoomLevel];
  const totalHours = endHour - startHour;
  const totalWidth = totalHours * config.pixelsPerHour;

  return {
    startHour,
    endHour,
    totalHours,
    pixelsPerHour: config.pixelsPerHour,
    totalWidth,
    zoomLevel,
    snapMinutes: config.snapMinutes,
  };
}

/**
 * Parses "HH:mm" to minutes from start of day.
 */
export function timeStringToMinutes(timeStr: string): number {
  if (!timeStr) return 0;
  const [hStr, mStr] = timeStr.split(':');
  const h = parseInt(hStr, 10) || 0;
  const m = parseInt(mStr, 10) || 0;
  return h * 60 + m;
}

/**
 * Formats minutes from start of day to "HH:mm".
 */
export function minutesToTimeString(minutes: number): string {
  const total = Math.max(0, Math.floor(minutes));
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/**
 * Converts a time string ("09:30") to X pixel position relative to timeline start.
 */
export function timeToPixel(
  timeStr: string,
  dimensions: TimelineDimensions
): number {
  const minutes = timeStringToMinutes(timeStr);
  const startMinutes = dimensions.startHour * 60;
  const deltaMinutes = minutes - startMinutes;
  const pixelsPerMinute = dimensions.pixelsPerHour / 60;
  return Math.max(0, deltaMinutes * pixelsPerMinute);
}

/**
 * Converts an X pixel offset into a "HH:mm" time string.
 */
export function pixelToTime(
  pixelX: number,
  dimensions: TimelineDimensions
): string {
  const pixelsPerMinute = dimensions.pixelsPerHour / 60;
  const deltaMinutes = pixelX / pixelsPerMinute;
  const totalMinutes = dimensions.startHour * 60 + deltaMinutes;
  return minutesToTimeString(totalMinutes);
}

/**
 * Computes width in pixels for an activity duration in minutes.
 */
export function intervalToWidth(
  durationMinutes: number,
  dimensions: TimelineDimensions
): number {
  const pixelsPerMinute = dimensions.pixelsPerHour / 60;
  return Math.max(12, durationMinutes * pixelsPerMinute);
}

/**
 * Snaps a time string or minute value to the nearest snap interval (15 or 30 mins).
 */
export function snapTime(
  timeStr: string,
  snapMinutes: 15 | 30 = 15
): string {
  const minutes = timeStringToMinutes(timeStr);
  const snapped = Math.round(minutes / snapMinutes) * snapMinutes;
  return minutesToTimeString(snapped);
}

/**
 * Snaps a pixel position to the nearest grid line.
 */
export function snapPixel(
  pixelX: number,
  dimensions: TimelineDimensions
): number {
  const timeStr = pixelToTime(pixelX, dimensions);
  const snappedTime = snapTime(timeStr, dimensions.snapMinutes);
  return timeToPixel(snappedTime, dimensions);
}

/**
 * Generates regular interval time headers for the timeline and heatmap.
 */
export function generateTimeIntervals(
  dimensions: TimelineDimensions
): { timeStr: string; label: string; xPixel: number; widthPixel: number }[] {
  const intervals: { timeStr: string; label: string; xPixel: number; widthPixel: number }[] = [];
  const config = ZOOM_CONFIGS[dimensions.zoomLevel];
  const stepMinutes = config.stepMinutes;
  const totalMinutes = dimensions.totalHours * 60;

  for (let m = 0; m < totalMinutes; m += stepMinutes) {
    const timeVal = dimensions.startHour * 60 + m;
    const timeStr = minutesToTimeString(timeVal);
    const xPixel = timeToPixel(timeStr, dimensions);
    const widthPixel = (stepMinutes / 60) * dimensions.pixelsPerHour;

    intervals.push({
      timeStr,
      label: timeStr,
      xPixel,
      widthPixel,
    });
  }

  return intervals;
}
