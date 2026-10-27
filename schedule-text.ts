// Small text helpers for the schedule (names of days, and times written on the Ethiopian clock).
import { formatEthiopian, localTime } from "./clock";

export const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// "5:30 daytime (Ethiopian time)"
export function etTime(minuteOfDay: number): string {
  return `${formatEthiopian(minuteOfDay)} (Ethiopian time)`;
}

export function etTimeFromEpoch(epochSeconds: number): string {
  return etTime(Math.floor(localTime(epochSeconds).secondOfDay / 60));
}
