import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppMode } from "@/shared/lib/config";

afterEach(() => vi.unstubAllEnvs());

describe("getAppMode", () => {
  it("defaults to patient when APP_MODE is unset", () => {
    vi.stubEnv("APP_MODE", "");
    expect(getAppMode()).toBe("patient");
  });

  it("selects doctor only for an explicit, exact match", () => {
    vi.stubEnv("APP_MODE", "doctor");
    expect(getAppMode()).toBe("doctor");
  });

  it("is case-insensitive", () => {
    vi.stubEnv("APP_MODE", "DOCTOR");
    expect(getAppMode()).toBe("doctor");
  });

  it("falls back to patient for any other value, rather than guessing", () => {
    vi.stubEnv("APP_MODE", "physician");
    expect(getAppMode()).toBe("patient");
  });
});
