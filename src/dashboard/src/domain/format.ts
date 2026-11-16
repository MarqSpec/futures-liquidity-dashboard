/** What price formatting needs from an instrument. */
export interface TickSpec {
  readonly tickSize: number;
  readonly priceDecimals: number;
}

/** Converts integer ticks to a price, rounded to the instrument's decimals so 0.1 steps never print 0.30000000004. */
export function ticksToPrice(ticks: number, spec: TickSpec): number {
  const factor = 10 ** spec.priceDecimals;
  return Math.round(ticks * spec.tickSize * factor) / factor;
}

/** Converts a price to the nearest whole tick. */
export function priceToTicks(price: number, spec: TickSpec): number {
  return Math.round(price / spec.tickSize);
}

/** Formats ticks as a price with the instrument's decimals; "—" for a missing or non-finite value. */
export function formatTicks(ticks: number | null | undefined, spec: TickSpec): string {
  if (ticks === null || ticks === undefined || !Number.isFinite(ticks)) {
    return "—";
  }
  return ticksToPrice(ticks, spec).toFixed(spec.priceDecimals);
}

/** Formats a tick range as "low – high", or one price when both ends are equal. */
export function formatTickRange(low: number, high: number, spec: TickSpec): string {
  return low === high ? formatTicks(low, spec) : `${formatTicks(low, spec)} – ${formatTicks(high, spec)}`;
}

/** Formats a whole quantity with thousands separators, or with k/M once it is large. */
export function formatQty(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 10_000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return Math.round(value).toLocaleString("en-US");
}

/** Formats a quantity with an explicit sign: +12, −5, 0. */
export function formatSigned(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (value > 0) {
    return `+${formatQty(value)}`;
  }
  return value < 0 ? `−${formatQty(-value)}` : "0";
}

/** Formats a 0–1 fraction as a percentage. */
export function formatPercent(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) {
    return "—";
  }
  return `${(fraction * 100).toFixed(digits)} %`;
}

const localTime = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const localMinute = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

const chicagoTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const chicagoMinute = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** The browser's local time of a Unix-ms instant, HH:MM:SS. */
export function formatLocalTime(ms: number): string {
  return localTime.format(ms);
}

/** The browser's local time of a Unix-ms instant, HH:MM. */
export function formatLocalMinute(ms: number): string {
  return localMinute.format(ms);
}

/** The exchange's (Chicago) time of a Unix-ms instant, "HH:MM:SS CT". */
export function formatChicagoTime(ms: number): string {
  return `${chicagoTime.format(ms)} CT`;
}

/** The exchange's (Chicago) time of a Unix-ms instant, HH:MM. */
export function formatChicagoMinute(ms: number): string {
  return chicagoMinute.format(ms);
}

/** A duration in ms as "350 ms", "4.2 s", "3 min" or "2 h". */
export function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return "—";
  }
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  if (ms < 3_600_000) {
    return `${Math.floor(ms / 60_000)} min`;
  }
  return `${(ms / 3_600_000).toFixed(1)} h`;
}
