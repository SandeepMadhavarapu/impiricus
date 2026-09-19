import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { ShareSection } from "@/doctor/components/ShareSection";

// Execute the real component's click handlers without adding a DOM dependency.
// Setters capture live-region messages; native APIs are explicit test doubles.
const { updates } = vi.hoisted(() => ({ updates: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial, updates],
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
}));
vi.mock("@/shared/lib/analytics/client", () => ({ track: vi.fn() }));
const url = "https://medbridge.example/medications/singulair-montelukast-10mg-tablet";
function buttons(node: ReactNode): ReactElement<{ onClick: () => Promise<void>; children: ReactNode; disabled?: boolean }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as ReactElement<{ children: ReactNode }>;
  return el.type === "button" ? [el as ReturnType<typeof buttons>[number]] : buttons(el.props.children);
}
function controls(configured = true, audience: "doctor" | "patient" = "doctor") {
  return buttons(ShareSection({ slug: "singulair-montelukast-10mg-tablet", shareUrl: url,
    productName: "Singulair (montelukast) 10 mg tablet", originIsConfigured: configured, audience }));
}
const copy = vi.fn();
beforeEach(() => { updates.mockClear(); copy.mockReset().mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllGlobals());

describe("shared native share controls", () => {
  it("calls native share synchronously from the click with only public product data", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share, clipboard: { writeText: copy } });
    const pending = controls()[0]!.props.onClick();
    expect(share).toHaveBeenCalledExactlyOnceWith({ url,
      title: "Singulair (montelukast) 10 mg tablet — what it is, benefits and risks",
      text: "Plain-language information about Singulair (montelukast) 10 mg tablet, sourced from the FDA-approved label.",
    });
    await pending;
    expect(updates).toHaveBeenCalledWith(expect.stringContaining("Patient guide ready to share"));
    expect(copy).not.toHaveBeenCalled();
  });
  it("treats cancellation normally and does not copy unexpectedly", async () => {
    vi.stubGlobal("navigator", { share: vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError")), clipboard: { writeText: copy } });
    await controls()[0]!.props.onClick();
    expect(updates).toHaveBeenCalledWith("Sharing cancelled.");
    expect(copy).not.toHaveBeenCalled();
  });
  it.each([false, true])("copies the bare public link when native share is unavailable or fails (%j)", async (fails) => {
    vi.stubGlobal("navigator", { ...(fails ? { share: vi.fn().mockRejectedValue(new Error("Denied")) } : {}), clipboard: { writeText: copy } });
    await controls()[0]!.props.onClick();
    expect(copy).toHaveBeenCalledWith(url);
    expect(updates).toHaveBeenCalledWith(expect.stringContaining("Patient guide ready to share"));
  });
  it("offers manual copying if clipboard permission is denied", async () => {
    copy.mockRejectedValue(new Error("Denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
    await controls()[1]!.props.onClick();
    expect(updates).toHaveBeenCalledWith(expect.stringContaining("copy it manually"));
    expect(updates).not.toHaveBeenCalledWith(expect.stringContaining("Patient guide ready"));
  });
  it("Copy Link bypasses native sharing", async () => {
    const share = vi.fn();
    vi.stubGlobal("navigator", { share, clipboard: { writeText: copy } });
    await controls()[1]!.props.onClick();
    expect(copy).toHaveBeenCalledWith(url);
    expect(share).not.toHaveBeenCalled();
  });
  it("blocks doctor sharing until configured, including handlers", async () => {
    const share = vi.fn();
    vi.stubGlobal("navigator", { share, clipboard: { writeText: copy } });
    const [primary, fallback] = controls(false);
    expect(primary!.props.disabled).toBe(true);
    await primary!.props.onClick();
    await fallback!.props.onClick();
    expect(share).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });
  it("preserves patient copy fallback and status", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
    await controls(false, "patient")[0]!.props.onClick();
    expect(copy).toHaveBeenCalledWith(url);
    expect(updates).toHaveBeenCalledWith("Link copied. Paste it anywhere to share.");
  });
});
