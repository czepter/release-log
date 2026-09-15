// Ein Zähler je Schlüssel mit festem Zeitfenster -- kein Leaky-Bucket, keine
// gleitende Berechnung. Dieser Dienst läuft als ein Prozess; ein Neustart
// setzt jeden Zähler zurück, was für eine Ratenbegrenzung gegen Missbrauch
// reicht (spec §5, Abweichung 5).
export type RateLimiter = { check(key: string): boolean };

export function rateLimiter(limit: number, windowMs: number, nowMs: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { windowStart: number; count: number }>();
  return {
    check(key) {
      const now = nowMs();
      const entry = windows.get(key);
      if (!entry || now - entry.windowStart >= windowMs) {
        windows.set(key, { windowStart: now, count: 1 });
        return true;
      }
      if (entry.count >= limit) return false;
      entry.count += 1;
      return true;
    },
  };
}
