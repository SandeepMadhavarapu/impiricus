import { describe, it, expect } from "vitest";
import {
  assessUrgency,
  urgentGuidance,
  shouldOfferCrisisFooter,
} from "@/lib/safety/urgent";

describe("crisis detection", () => {
  const crisisMessages = [
    "I want to kill myself",
    "i'm thinking about suicide",
    "I am having suicidal thoughts since starting this",
    "I don't want to live anymore",
    "I feel like hurting myself",
    "going to kill myself tonight",
    "my son is talking about suicide since he started this medicine",
  ];

  it.each(crisisMessages)("treats %j as a crisis", (msg) => {
    const a = assessUrgency(msg);
    expect(a.level).toBe("crisis");
    expect(a.kind).toBe("self-harm");
    const g = urgentGuidance(a)!;
    expect(g.continueToAnswer).toBe(false);
    expect(g.resources.map((r) => r.href)).toContain("tel:988");
  });

  /**
   * The whole point of this page is public awareness of a boxed warning about
   * suicidality. Asking about that risk must get a real answer.
   */
  const informationalMessages = [
    "Can this medication cause suicidal thoughts?",
    "does montelukast cause depression?",
    "What are the side effects?",
    "How common is depression with this drug?",
    "is it true that this is linked to mood changes",
    "why does it have a boxed warning about suicide",
  ];

  it.each(informationalMessages)("does NOT intercept the informational question %j", (msg) => {
    expect(assessUrgency(msg).level).toBe("none");
  });

  it("offers crisis resources alongside answers about neuropsychiatric risk", () => {
    expect(shouldOfferCrisisFooter("Can this cause suicidal thoughts?")).toBe(true);
    expect(shouldOfferCrisisFooter("does it cause depression")).toBe(true);
    expect(shouldOfferCrisisFooter("what is the tablet colour")).toBe(false);
  });
});

describe("overdose detection", () => {
  const overdoseMessages = [
    "I took too many tablets",
    "my daughter got into the bottle",
    "he swallowed the whole bottle",
    "I accidentally double-dosed",
    "I took 6 tablets by mistake",
  ];

  it.each(overdoseMessages)("treats %j as a crisis", (msg) => {
    const a = assessUrgency(msg);
    expect(a.level).toBe("crisis");
    expect(a.kind).toBe("overdose");
    const g = urgentGuidance(a)!;
    expect(g.resources.map((r) => r.href)).toContain("tel:18002221222");
    expect(g.continueToAnswer).toBe(false);
  });

  it("does not intercept a general question about overdose", () => {
    expect(assessUrgency("What happens if you overdose on this?").level).toBe("none");
    expect(assessUrgency("what does the label say about overdosage").level).toBe("none");
  });
});

describe("urgent physical symptoms", () => {
  it("routes swelling and breathing trouble to emergency care", () => {
    for (const msg of [
      "my throat is swelling",
      "swelling of my lips",
      "I can't breathe",
      "having difficulty swallowing",
    ]) {
      const a = assessUrgency(msg);
      expect(a.level).toBe("urgent");
      expect(a.kind).toBe("severe-allergic-reaction");
      expect(urgentGuidance(a)!.resources.map((r) => r.href)).toContain("tel:911");
    }
  });

  it("routes a severe asthma attack to emergency care and says this is not a rescue med", () => {
    const a = assessUrgency("I am having a bad asthma attack and my rescue inhaler is not working");
    expect(a.level).toBe("urgent");
    const g = urgentGuidance(a)!;
    expect(g.body.join(" ")).toMatch(/not a rescue medication/i);
    expect(g.continueToAnswer).toBe(false);
  });
});

describe("ordinary questions", () => {
  it.each([
    "What is this medication used for?",
    "Can I take it with warfarin?",
    "How do I check my insurance coverage?",
    "what should I ask my pharmacist",
    "",
  ])("leaves %j alone", (msg) => {
    const a = assessUrgency(msg);
    expect(a.level).toBe("none");
    expect(urgentGuidance(a)).toBeNull();
  });
});
