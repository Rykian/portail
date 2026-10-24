// "short", not "narrow": with current ICU data the French narrow style reads "-2 h" instead of "il y a 2 h".
const format = new Intl.RelativeTimeFormat("fr", { style: "short" });

export function relativeTime(from: Date, now: Date): string {
  const seconds = Math.floor((now.getTime() - from.getTime()) / 1000);
  if (seconds < 60) return "à l’instant";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return format.format(-hours, "hour");
  return format.format(-Math.floor(hours / 24), "day");
}
