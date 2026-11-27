// Who is staying in a room right now, from Uplisting. Read only: nothing here ever sends anything
// but a GET, and only the guest's FIRST NAME leaves this file.
//
// Uplisting's API is at https://connect.uplisting.io, with HTTP Basic auth: the API key from
// Uplisting's Connect page, base64 encoded. A host's API key lists a property's bookings at
//   GET /bookings/<property id>?from=YYYY-MM-DD&to=YYYY-MM-DD      (Uplisting's "API key" collection)
// The newer OAuth API (a bearer token, not a key) uses GET /bookings?property_id=<id> instead; it is
// kept as a fallback. /api/health says which one answered.

export const UPLISTING_BASE = "https://connect.uplisting.io";

/** Uplisting sends names HTML escaped ("O&#39;Boyle"). */
export function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** "Johanna O&#39;Boyle" -> "Johanna". "Javed Ahmad Javed Ahmad" -> "Javed". Anything odd -> "". */
export function firstName(raw) {
  const word = decodeEntities(raw).trim().split(/\s+/)[0] || "";
  if (!/^\p{L}[\p{L}'’-]{0,29}$/u.test(word)) return "";   // a real name: letters, apostrophe, hyphen
  if (word.length > 1 && word === word.toUpperCase()) return word[0] + word.slice(1).toLowerCase();   // MARIA -> Maria
  return word[0].toUpperCase() + word.slice(1);
}

const NOT_STAYING = /cancel|declin|expir|inquir|pending|denied|no.?show|reject/i;

/** Today's date (YYYY-MM-DD) and the time (HH:MM) in a time zone. */
export function localNow(tz, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * The booking that is on now: not cancelled, checked in on or before today, and either leaving after
 * today or leaving today but not yet past its departure time. On a same-day turnover the guest still
 * leaving keeps the screen until their departure time, then the arriving guest has it.
 */
export function currentBooking(bookings, today, time, defaultDeparture = "11:00") {
  const on = (bookings || []).map((b) => b.attributes || b).filter((b) => {
    if (!b || !b.check_in || !b.check_out || b.cancelled_dt || NOT_STAYING.test(String(b.status || ""))) return false;
    if (b.check_in > today) return false;
    if (b.check_out > today) return true;
    return b.check_out === today && time < String(b.departure_time || defaultDeparture).slice(0, 5);
  });
  // a guest still leaving this morning keeps the screen until their departure time
  const leaving = on.find((b) => b.check_out === today);
  if (leaving) return leaving;
  on.sort((a, b) => (a.check_in < b.check_in ? 1 : -1));
  return on[0] || null;
}

function addDays(date, n) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** GET only. Returns { bookings, route }. Throws with a short reason (never the key). */
export async function fetchBookings(propertyId, apiKey, today, fetchImpl = fetch) {
  const from = addDays(today, -60), to = addDays(today, 1);   // a stay that began in the last 60 days and is still on
  const auth = { Authorization: "Basic " + btoa(apiKey), Accept: "application/json" };
  const routes = [
    ["key", `${UPLISTING_BASE}/bookings/${encodeURIComponent(propertyId)}?` + new URLSearchParams({ from, to, per_page: "50" })],
    ["oauth", `${UPLISTING_BASE}/bookings?` + new URLSearchParams({ property_id: String(propertyId), from, to })],
  ];
  let why = "";
  for (const [route, url] of routes) {
    const r = await fetchImpl(url, { method: "GET", headers: auth, signal: AbortSignal.timeout(10000) });
    if (r.status === 401 || r.status === 403) throw new Error("Uplisting refused the key (" + r.status + ")");
    if (r.status === 429) throw new Error("Uplisting says slow down (429)");
    if (!r.ok) { why = `${route} route ${r.status}`; continue; }
    const body = await r.json();
    const list = Array.isArray(body) ? body : (body.data || body.bookings);
    if (!Array.isArray(list)) { why = `${route} route: unexpected answer`; continue; }
    return { bookings: list, route };
  }
  throw new Error("Uplisting: " + why);
}
