import { describe, it, expect, beforeEach } from "vitest";
import {
  sanitizeEvent,
  isAnalyticsEvent,
  ANALYTICS_EVENTS,
  FORBIDDEN_EVENT_SEMANTICS,
} from "@/shared/lib/analytics/events";
import { rateLimit, resetRateLimits, clientKey } from "@/shared/lib/security/ratelimit";
import { PROVIDER_ROUTES, ADVERSE_EVENT_REPORTING, getRoute } from "@/doctor/lib/providers/routes";

describe("analytics sanitisation", () => {
  it("drops unknown events entirely", () => {
    expect(sanitizeEvent("question_asked", {})).toBeNull();
    expect(sanitizeEvent("chat_message", { text: "hi" })).toBeNull();
    expect(isAnalyticsEvent("arbitrary_event")).toBe(false);
  });

  /** The failure this guards against: chat text reaching an analytics sink. */
  it("strips any property that is not explicitly allow-listed", () => {
    const sanitized = sanitizeEvent("learn_more_opened", {
      question: "do I have cancer",
      medication_slug: "singulair-montelukast-10mg-tablet",
      insurer: "Example Health",
      member_id: "12345",
      user_email: "someone@example.com",
    });
    expect(sanitized).not.toBeNull();
    expect(sanitized!.properties).toEqual({});
  });

  it("keeps allow-listed properties with allow-listed values", () => {
    expect(sanitizeEvent("share_initiated", { method: "web-share" })!.properties).toEqual({
      method: "web-share",
    });
    // An out-of-range value is dropped rather than passed through.
    expect(sanitizeEvent("share_initiated", { method: "airdrop" })!.properties).toEqual({});
  });

  it("never records a medication slug on any event", () => {
    for (const event of ANALYTICS_EVENTS) {
      const sanitized = sanitizeEvent(event, {
        slug: "singulair-montelukast-10mg-tablet",
        medication: "singulair",
      });
      expect(Object.keys(sanitized!.properties)).not.toContain("slug");
      expect(Object.keys(sanitized!.properties)).not.toContain("medication");
    }
  });

  it("has no event that claims delivery, receipt, or a booked appointment", () => {
    for (const event of ANALYTICS_EVENTS) {
      for (const forbidden of FORBIDDEN_EVENT_SEMANTICS) {
        expect(event, `event "${event}" implies "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  it("names share events as initiated, not delivered", () => {
    expect(ANALYTICS_EVENTS).toContain("share_initiated");
    expect(ANALYTICS_EVENTS as readonly string[]).not.toContain("share_delivered");
    expect(ANALYTICS_EVENTS as readonly string[]).not.toContain("share_completed");
  });

  it("tolerates junk payloads", () => {
    for (const junk of [null, undefined, "string", 42, [], { a: { b: 1 } }]) {
      expect(sanitizeEvent("qr_shown", junk)!.properties).toEqual({});
    }
  });
});

describe("rate limiting", () => {
  beforeEach(() => resetRateLimits());

  it("allows up to the limit then blocks", () => {
    for (let i = 0; i < 3; i++) {
      expect(rateLimit("k", 3, 60_000).allowed).toBe(true);
    }
    const blocked = rateLimit("k", 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("tracks keys independently", () => {
    expect(rateLimit("a", 1, 60_000).allowed).toBe(true);
    expect(rateLimit("a", 1, 60_000).allowed).toBe(false);
    expect(rateLimit("b", 1, 60_000).allowed).toBe(true);
  });

  it("resets after the window", async () => {
    expect(rateLimit("w", 1, 30).allowed).toBe(true);
    expect(rateLimit("w", 1, 30).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 45));
    expect(rateLimit("w", 1, 30).allowed).toBe(true);
  });

  it("derives a non-reversible key that does not contain the IP", async () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.42, 10.0.0.1" });
    const key = await clientKey(headers);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(key).not.toContain("203.0.113.42");
  });

  it("gives the same client a stable key and different clients different keys", async () => {
    const a = await clientKey(new Headers({ "x-forwarded-for": "203.0.113.42" }));
    const b = await clientKey(new Headers({ "x-forwarded-for": "203.0.113.42" }));
    const c = await clientKey(new Headers({ "x-forwarded-for": "198.51.100.7" }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("provider routes", () => {
  it("offers a route for each distinct intent", () => {
    const intents = PROVIDER_ROUTES.map((r) => r.intent);
    expect(new Set(intents).size).toBe(intents.length);
    expect(intents).toEqual(
      expect.arrayContaining(["existing-clinician", "pharmacist", "new-provider", "telehealth"])
    );
  });

  it("marks telehealth booking unavailable rather than faking it", () => {
    const route = getRoute("telehealth")!;
    expect(route.availability).toBe("unavailable");
    expect(route.limitations.join(" ")).toMatch(/No appointment can be created/i);
  });

  /** Every external link must be a real https destination, not a placeholder. */
  it("only links to verified https destinations, each with a checked date", () => {
    for (const route of PROVIDER_ROUTES) {
      for (const action of route.actions) {
        if (!action.href) continue;
        expect(action.href).toMatch(/^https:\/\//);
        expect(action.href).not.toMatch(/example\.com|placeholder|TODO|localhost/i);
      }
      for (const src of route.sources) {
        expect(src.url).toMatch(/^https:\/\//);
        expect(src.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    for (const action of ADVERSE_EVENT_REPORTING.actions) {
      expect(action.href).toMatch(/^(https:\/\/|tel:)/);
    }
  });

  it("states directory limitations instead of implying availability", () => {
    const route = getRoute("new-provider")!;
    const limits = route.limitations.join(" ").toLowerCase();
    expect(limits).toContain("accepting new patients");
    expect(limits).toContain("insurance network");
    expect(limits).toContain("licensure");
  });

  it("never lists a named provider or an NPI", () => {
    const blob = JSON.stringify(PROVIDER_ROUTES).toLowerCase();
    expect(blob).not.toMatch(/\bnpi\b\s*[:=]\s*\d/);
    expect(blob).not.toMatch(/\bdr\.\s+[a-z]+/);
  });

  it("returns null for an unknown intent", () => {
    // @ts-expect-error deliberately invalid intent
    expect(getRoute("something-else")).toBeNull();
  });
});
