import "server-only";

/**
 * Integration configuration and status.
 *
 * Every external integration in this app is explicitly either CONFIGURED or
 * UNCONFIGURED, and the UI is required to reflect which. There is no mode where
 * a missing credential quietly degrades into invented data.
 *
 * This module is server-only. Nothing here may be imported into a client
 * component; secrets must never reach the browser.
 */

export type IntegrationStatus = "configured" | "unconfigured";

export interface IntegrationState {
  id: string;
  name: string;
  status: IntegrationStatus;
  /** What the user can actually do right now. */
  capability: string;
  /** The single env var (or vars) that would switch this on. */
  requires: string[];
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function flag(name: string): boolean {
  return env(name)?.toLowerCase() === "true";
}

/* ------------------------------------------------------------------- mode */

export type AppMode = "patient" | "doctor";

/**
 * Which audience this deployment's root path ("/") is for.
 *
 * The doctor workspace (`/doctor`) and the patient page (`/medications/...`)
 * are both always reachable regardless of this setting — it only decides
 * where "/" sends someone, so the same build can be deployed twice under two
 * domains: one that opens straight to the patient experience (what a shared
 * link should show), and one that opens straight to the doctor demo
 * workspace. Defaults to "patient" — the patient experience is what a real
 * shared link must show, so an unset or misconfigured value must never
 * silently land someone on the doctor workspace instead.
 */
export function getAppMode(): AppMode {
  return env("APP_MODE")?.toLowerCase() === "doctor" ? "doctor" : "patient";
}

/* ------------------------------------------------------------------ origin */

/**
 * The public origin used to build absolute share URLs and QR codes.
 *
 * Validated rather than trusted: a bad value here would produce share links
 * that go nowhere, or worse, to somebody else's host. We never derive this from
 * a request Host header, which is attacker-controlled.
 */
export function getPublicOrigin(): { origin: string; source: "configured" | "fallback" } {
  const configured = env("PUBLIC_ORIGIN") ?? env("NEXT_PUBLIC_SITE_ORIGIN");
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        throw new Error("PUBLIC_ORIGIN must be https (or localhost for development)");
      }
      // Normalise away any path/query someone pasted in.
      return { origin: url.origin, source: "configured" };
    } catch {
      // Fall through to the development default rather than emitting a broken
      // absolute URL into a QR code.
    }
  }
  const port = env("PORT") ?? "3000";
  return { origin: `http://localhost:${port}`, source: "fallback" };
}

/* --------------------------------------------------------------- assistant */

export type AssistantProvider = "anthropic" | "impiricus" | "none";

export interface AssistantConfig {
  provider: AssistantProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Impiricus only: the audience the credential is authorised for. */
  audience?: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export function getAssistantConfig(): AssistantConfig {
  const requested = (env("ASSISTANT_PROVIDER") ?? "").toLowerCase();

  // Impiricus takes precedence only when fully configured AND explicitly
  // declared patient-facing. An HCP-only credential must not be repurposed.
  if (requested === "impiricus") {
    const apiKey = env("IMPIRICUS_API_KEY");
    const baseUrl = env("IMPIRICUS_API_BASE_URL");
    const audience = env("IMPIRICUS_AUDIENCE");
    if (apiKey && baseUrl && audience === "patient") {
      return {
        provider: "impiricus",
        model: env("IMPIRICUS_MODEL") ?? "documented-default",
        apiKey,
        baseUrl,
        audience,
        maxOutputTokens: 1024,
        timeoutMs: 25_000,
      };
    }
    return unconfiguredAssistant();
  }

  const apiKey = env("ANTHROPIC_API_KEY");
  if (apiKey && requested !== "none") {
    return {
      provider: "anthropic",
      model: env("ANTHROPIC_MODEL") ?? "claude-sonnet-5",
      apiKey,
      baseUrl: env("ANTHROPIC_BASE_URL_OVERRIDE") ?? "https://api.anthropic.com",
      maxOutputTokens: 1024,
      timeoutMs: 25_000,
    };
  }

  return unconfiguredAssistant();
}

function unconfiguredAssistant(): AssistantConfig {
  return { provider: "none", model: "", maxOutputTokens: 0, timeoutMs: 0 };
}

/* ---------------------------------------------------------------- coverage */

export type CoverageProvider = "none" | "sample";

export interface CoverageConfig {
  provider: CoverageProvider;
  /**
   * Sample mode returns clearly-labelled fictional scenarios so the result
   * states can be demonstrated. It is opt-in, never a fallback, and the UI
   * must render a persistent "Sample data" banner when it is on.
   */
  sampleModeEnabled: boolean;
}

export function getCoverageConfig(): CoverageConfig {
  const sampleModeEnabled = flag("ENABLE_SAMPLE_COVERAGE");
  return {
    provider: sampleModeEnabled ? "sample" : "none",
    sampleModeEnabled,
  };
}

/* ------------------------------------------------------- provider referral */

export interface ReferralConfig {
  /**
   * When unconfigured (the default), the app does not accept personal
   * information at all. It helps the user contact their own clinician or
   * pharmacist instead. See docs/INTEGRATIONS.md.
   */
  provider: "none" | "configured";
  endpoint?: string;
}

export function getReferralConfig(): ReferralConfig {
  const endpoint = env("REFERRAL_API_BASE_URL");
  const key = env("REFERRAL_API_KEY");
  if (endpoint && key) return { provider: "configured", endpoint };
  return { provider: "none" };
}

/* --------------------------------------------------------------- analytics */

export function getAnalyticsConfig(): { enabled: boolean } {
  return { enabled: flag("ANALYTICS_ENABLED") };
}

/* ------------------------------------------------------------------ status */

/** The integration status table rendered in the UI and in docs. */
export function getIntegrationStates(): IntegrationState[] {
  const assistant = getAssistantConfig();
  const coverage = getCoverageConfig();
  const referral = getReferralConfig();
  const origin = getPublicOrigin();

  return [
    {
      id: "medication-content",
      name: "Medication content (FDA label)",
      status: "configured",
      capability:
        "Live. Content is fetched from openFDA and DailyMed and stored with full provenance.",
      requires: [],
    },
    {
      id: "assistant",
      name: "Medication assistant",
      status: assistant.provider === "none" ? "unconfigured" : "configured",
      capability:
        assistant.provider === "none"
          ? "Label excerpt search only (deterministic, no AI). Conversational answers require a model credential."
          : `Grounded conversational answers via ${assistant.provider}.`,
      requires: ["ANTHROPIC_API_KEY", "ASSISTANT_PROVIDER"],
    },
    {
      id: "coverage",
      name: "Insurance coverage",
      status: coverage.provider === "none" ? "unconfigured" : "configured",
      capability:
        coverage.provider === "none"
          ? "Full input and result-state flow, returning 'unable to verify'. No payer connection exists."
          : "Sample mode — clearly labelled fictional scenarios for demonstration only.",
      requires: ["A real payer/formulary API credential (none available)"],
    },
    {
      id: "referral",
      name: "Provider referral submission",
      status: referral.provider === "none" ? "unconfigured" : "configured",
      capability:
        referral.provider === "none"
          ? "No personal information is transmitted or stored. Verified public contact routes are offered instead."
          : "Referral submission to the configured scheduling system.",
      requires: ["REFERRAL_API_BASE_URL", "REFERRAL_API_KEY"],
    },
    {
      id: "origin",
      name: "Public share origin",
      status: origin.source === "configured" ? "configured" : "unconfigured",
      capability:
        origin.source === "configured"
          ? `Share links and QR codes use ${origin.origin}.`
          : `Falling back to ${origin.origin}. Set PUBLIC_ORIGIN before deploying or shared links will not resolve off-device.`,
      requires: ["PUBLIC_ORIGIN"],
    },
  ];
}
