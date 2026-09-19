import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { NearbyShare } from "@/doctor/components/NearbyShare";
import { DEFAULT_MEDICATION_SLUG } from "@/sources/lib/content/registry";

const state = vi.hoisted(() => ({ busy: false }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial === false ? state.busy : initial, vi.fn()],
  useRef: () => ({ current: null }),
  useEffect: () => {},
}));
afterEach(() => { state.busy = false; vi.unstubAllEnvs(); });
function buttons(node: ReactNode): ReactElement<{ disabled?: boolean; children: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ disabled?: boolean; children: ReactNode }>;
  return element.type === "button" ? [element] : buttons(element.props.children);
}
it.each([false, true])("keeps the production transmit button disabled exactly while busy (%j)", busy => {
  vi.stubEnv("NODE_ENV", "production"); state.busy = busy;
  const controls = buttons(NearbyShare({ slug: DEFAULT_MEDICATION_SLUG }));
  expect(controls[0]!.props.disabled).toBe(busy);
  expect(controls[0]!.props.children).toBe(busy ? "Sending…" : "Send Nearby");
  if (busy) expect(controls[1]!.props.children).toBe("Cancel");
});
