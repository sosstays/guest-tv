// node test-uplisting.mjs : the Uplisting guest rules, with made-up guests (the repo is public, so no
// real names here). No network.
import assert from "node:assert/strict";
import { currentBooking, decodeEntities, fetchBookings, firstName, localNow } from "./lib/uplisting.mjs";

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("ok", name); };

ok("names: escaped, doubled, caps, odd", () => {
  assert.equal(firstName("Maeve O&#39;Neill"), "Maeve");
  assert.equal(firstName("Sam Rivers Sam Rivers"), "Sam");
  assert.equal(firstName("MARIA LOPEZ"), "Maria");
  assert.equal(firstName("Jean-Luc Picard"), "Jean-Luc");
  assert.equal(firstName("Zoë Quinn"), "Zoë");
  assert.equal(firstName("O&#39;Brien Family"), "O'Brien");
  assert.equal(firstName(""), "");
  assert.equal(firstName(null), "");
  assert.equal(firstName("12345 x"), "");
  assert.equal(firstName("<script>alert(1)</script>"), "");
  assert.equal(firstName("a@b.com"), "");
  assert.equal(decodeEntities("A &amp; B &#x27;c&#x27;"), "A & B 'c'");
});

const bk = (guest_name, check_in, check_out, extra = {}) => ({ type: "bookings", attributes: { guest_name, check_in, check_out, departure_time: "11:00:00", status: "confirmed", cancelled_dt: null, ...extra } });
const list = [
  bk("Past Guest", "2026-11-16", "2026-11-20", { status: "needs_check_out" }),
  bk("Cancelled Guest", "2026-11-20", "2026-11-30", { status: "cancelled" }),
  bk("Future Guest", "2026-12-08", "2026-12-17"),
];

ok("who is on now", () => {
  assert.equal(currentBooking(list, "2026-11-26", "10:00"), null);                 // nobody today
  assert.equal(currentBooking(list, "2026-12-07", "20:00"), null);                 // day before check-in
  assert.equal(currentBooking(list, "2026-12-08", "00:30"), null);                 // check-in day, before 15:00
  assert.equal(currentBooking(list, "2026-12-08", "14:59"), null);
  assert.equal(currentBooking(list, "2026-12-08", "15:00").guest_name, "Future Guest");   // from check-in time
  assert.equal(currentBooking(list, "2026-12-09", "03:00").guest_name, "Future Guest");   // later days: all day
  assert.equal(currentBooking(list, "2026-12-16", "23:00").guest_name, "Future Guest");   // last night
  assert.equal(currentBooking(list, "2026-12-17", "10:59").guest_name, "Future Guest");   // check-out morning
  assert.equal(currentBooking(list, "2026-12-17", "11:00"), null);                 // after departure time
});
ok("cancelled and odd statuses never count", () => {
  assert.equal(currentBooking([bk("X", "2026-11-20", "2026-11-30", { status: "cancelled" })], "2026-11-25", "12:00"), null);
  assert.equal(currentBooking([bk("X", "2026-11-20", "2026-11-30", { cancelled_dt: "2026-11-19T10:00:00Z" })], "2026-11-25", "12:00"), null);
  assert.equal(currentBooking([bk("X", "2026-11-20", "2026-11-30", { status: "inquiry" })], "2026-11-25", "12:00"), null);
});
ok("same-day turnover: the leaver keeps the screen until departure", () => {
  const t = [bk("Leaving", "2026-12-01", "2026-12-05"), bk("Arriving", "2026-12-05", "2026-12-07")];
  assert.equal(currentBooking(t, "2026-12-05", "09:00").guest_name, "Leaving");   // before 11:00 the leaver is still here
  assert.equal(currentBooking(t, "2026-12-05", "12:00"), null);                      // gap between 11:00 and 15:00
  assert.equal(currentBooking(t, "2026-12-05", "15:30").guest_name, "Arriving");
});
ok("flat (non JSON:API) bookings work too", () => {
  assert.equal(currentBooking([{ guest_name: "Flat", check_in: "2026-12-01", check_out: "2026-12-03" }], "2026-12-02", "12:00").guest_name, "Flat");
  // the booking's own arrival time wins over the default
  assert.equal(currentBooking([{ guest_name: "Late", check_in: "2026-12-01", check_out: "2026-12-03", arrival_time: "17:00:00" }], "2026-12-01", "16:00"), null);
  assert.equal(currentBooking([{ guest_name: "Late", check_in: "2026-12-01", check_out: "2026-12-03", arrival_time: "17:00:00" }], "2026-12-01", "17:00").guest_name, "Late");
});
ok("local time in Dublin", () => {
  const w = localNow("Europe/Dublin", new Date("2026-07-01T23:30:00Z"));   // summer: UTC+1
  assert.deepEqual(w, { date: "2026-07-02", time: "00:30" });
  assert.deepEqual(localNow("Europe/Dublin", new Date("2026-12-01T23:30:00Z")), { date: "2026-12-01", time: "23:30" });
});

// fetchBookings: GET only, Basic auth, falls back to the second route, never leaks the key in errors
const calls = [];
const fake = (answers) => async (url, init) => {
  calls.push({ url: String(url), method: init.method, auth: init.headers.Authorization });
  const a = answers.shift();
  return { ok: a.s >= 200 && a.s < 300, status: a.s, json: async () => a.body };
};
await (async () => {
  calls.length = 0;
  const r = await fetchBookings(1, "secret-key", "2026-12-08", fake([{ s: 404 }, { s: 200, body: { data: [{}] } }]));
  assert.equal(r.route, "oauth");
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.ok(calls[0].url.includes("/bookings/1?from=2026-10-09&to=2026-12-09"));
  assert.equal(calls[0].auth, "Basic " + btoa("secret-key"));
  n++; console.log("ok fetch: falls back, GET only, Basic auth");
  await assert.rejects(fetchBookings(1, "secret-key", "2026-12-08", fake([{ s: 401 }])), (e) => /refused/.test(e.message) && !/secret-key/.test(e.message));
  await assert.rejects(fetchBookings(1, "k", "2026-12-08", fake([{ s: 500 }, { s: 500 }])), /Uplisting/);
  n++; console.log("ok fetch: 401 and 500 give clear errors without the key");
})();

console.log(n + " groups passed");
