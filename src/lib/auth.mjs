// Shared API-secret gate for the public Function URLs (log-session,
// dashboard-data). AuthType is NONE at the edge; the shared secret in the
// x-api-key header is the real boundary, checked in-handler before any other
// processing. Extracted here so both endpoints enforce it identically — one
// source of truth for the constant-time compare.
import { createHash, timingSafeEqual } from "node:crypto";

const API_SECRET = process.env.API_SECRET;

// Constant-time secret compare that also tolerates length differences: hash
// both sides to a fixed 32 bytes first, so timingSafeEqual never throws and the
// comparison time does not depend on where the mismatch is.
function secretMatches(provided) {
  if (typeof provided !== "string" || typeof API_SECRET !== "string") {
    return false;
  }
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(API_SECRET).digest();
  return timingSafeEqual(a, b);
}

// True iff the event carries a valid x-api-key. Function URL v2 lowercases
// header keys. Missing and wrong keys both return false — the caller returns a
// single generic 401 that never reveals which.
export function verifyApiSecret(event = {}) {
  const headers = event.headers || {};
  return secretMatches(headers["x-api-key"]);
}
