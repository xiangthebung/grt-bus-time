import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./src-hooks.mjs", import.meta.url));

const { relevantServiceDays, serviceDayAt } = await import("../src/time.ts");

test("service-day midnight stays correct across Toronto spring-forward", () => {
  const day = serviceDayAt(Date.parse("2026-03-08T07:30:00Z"));
  assert.equal(day.dateKey, "20260308");
  assert.equal(day.midnightMs, Date.parse("2026-03-08T05:00:00Z"));
});

test("service-day midnight stays correct across Toronto fall-back", () => {
  const day = serviceDayAt(Date.parse("2026-11-01T07:30:00Z"));
  assert.equal(day.dateKey, "20261101");
  assert.equal(day.midnightMs, Date.parse("2026-11-01T04:00:00Z"));
});

test("relevant service days are adjacent local calendar days, not 24-hour offsets", () => {
  const days = relevantServiceDays(Date.parse("2026-03-08T07:30:00Z"));
  assert.deepEqual(
    days.map(({ dateKey }) => dateKey),
    ["20260307", "20260308", "20260309"],
  );
  assert.equal(
    days[2].midnightMs - days[1].midnightMs,
    23 * 60 * 60 * 1000,
  );
});
