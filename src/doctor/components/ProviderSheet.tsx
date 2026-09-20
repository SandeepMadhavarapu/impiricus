"use client";

import { useState } from "react";
import { Sheet } from "@/patient/components/Sheet";
import { track } from "@/shared/lib/analytics/client";
import {
  PROVIDER_ROUTES,
  ADVERSE_EVENT_REPORTING,
  type ProviderIntent,
  type ProviderRoute,
} from "@/doctor/lib/providers/routes";
import {
  handoffReasonLabel,
  normaliseQuestion,
  type UnresolvedQuestion,
} from "@/doctor/lib/handoff";

/** Mirrors the /api/provider response. Kept local: the route is server-only. */
type NpiProvider = {
  npi: string;
  status: "active" | "deactivated" | "unrecognised";
  name: string;
  credential: string | null;
  primarySpecialty: string | null;
  practiceLocation: { city: string | null; state: string | null; phone: string | null } | null;
  yearsSinceCertification: number | null;
  possiblyStale: boolean;
};

type NpiResponse = {
  outcome:
    | { state: "found"; provider: NpiProvider }
    | { state: "not-found"; npi: string }
    | { state: "invalid-npi"; reason: string }
    | { state: "source-unavailable"; reason: string };
  disclaimer: string;
  limitations: readonly string[];
  checkedAt: string;
};

/**
 * Provider connection.
 *
 * First it asks WHO the person actually wants, because "connect me with a
 * provider" means four different things. Then it offers the strongest real
 * route for that choice, and says plainly when there is none.
 *
 * Nothing here is transmitted, so there is no recipient to confirm and no
 * personal information to handle. When a referral integration is configured,
 * that is where a confirm-before-send step belongs. See docs/INTEGRATIONS.md.
 */
export function ProviderSheet({
  open,
  onClose,
  productName,
  unresolved = null,
}: {
  open: boolean;
  onClose: () => void;
  productName: string;
  /**
   * The question the person came here still wanting answered. Carried from the
   * chat verbatim; never transmitted anywhere.
   */
  unresolved?: UnresolvedQuestion | null;
}) {
  const [intent, setIntent] = useState<ProviderIntent | null>(null);
  const route = intent ? PROVIDER_ROUTES.find((r) => r.intent === intent) ?? null : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Connect with a healthcare provider"
      subtitle={productName}
      labelledBy="provider-title"
    >
      <div className="chat-log">
        {!route ? (
          <>
            {unresolved && normaliseQuestion(unresolved.question) ? (
              <div className="card card--info" role="note">
                <p className="card-label" style={{ color: "var(--info-text)" }}>
                  Your question, carried over
                </p>
                <p style={{ fontSize: 16, fontWeight: 550 }}>
                  &ldquo;{normaliseQuestion(unresolved.question)}&rdquo;
                </p>
                <p className="tiny" style={{ marginTop: 8 }}>
                  {handoffReasonLabel(unresolved.reason)} It stays on your device. This site does
                  not send it to anyone.
                </p>
              </div>
            ) : null}

            {/*
              A banner, not a card. As a bordered box above a list of boxes it
              read as one more option to choose, which is exactly the wrong
              thing for the line that explains the choice.
            */}
            <p className="choose-banner">
              Who would you like to talk to? A pharmacist can usually answer a medication question
              today, for free.
            </p>

            <AccountBlock />

            <div className="route-list">
              {PROVIDER_ROUTES.map((r) => (
                <button
                  key={r.intent}
                  type="button"
                  className="route-btn"
                  onClick={() => {
                    setIntent(r.intent);
                    track("provider_route_selected", { intent: r.intent });
                  }}
                >
                  <strong>{r.chooseLabel}</strong>
                  <span>{r.description.split(". ")[0]}.</span>
                </button>
              ))}
            </div>

            <ReportingBlock />
          </>
        ) : (
          <RouteView
            route={route}
            unresolved={unresolved}
            onBack={() => setIntent(null)}
          />
        )}
        <NpiLookupBlock />
      </div>
    </Sheet>
  );
}

/**
 * Account entry point.
 *
 * A signed-in account is what would eventually make a real connection
 * possible: a verified identity to attach a message to. Nothing behind it is
 * built, so both buttons are disabled and labelled as coming later rather
 * than opening a form that cannot do anything with what it collects.
 */
function AccountBlock() {
  return (
    <div className="card card--flat account-block">
      <p className="card-label" style={{ color: "var(--text-muted)" }}>
        Your account
      </p>
      <p className="tiny" style={{ marginBottom: 12 }}>
        Signing in will let you message your own care team from here. Not available yet.
      </p>
      <div className="btn-row">
        <button type="button" className="btn btn--small" disabled>
          Sign in
        </button>
        <button type="button" className="btn btn--small" disabled>
          Create an account
        </button>
      </div>
    </div>
  );
}

function RouteView({
  route,
  unresolved,
  onBack,
}: {
  route: ProviderRoute;
  unresolved: UnresolvedQuestion | null;
  onBack: () => void;
}) {
  return (
    <>
      <button type="button" className="btn btn--small" onClick={onBack} style={{ alignSelf: "flex-start" }}>
        ← Choose someone else
      </button>

      {/*
        The question follows the person through the whole handoff, not just
        the chooser. Picking a route is exactly when it is about to be useful,
        so dropping it here would undo the point of carrying it.
      */}
      {unresolved && normaliseQuestion(unresolved.question) ? (
        <div className="card card--info" role="note">
          <p className="card-label" style={{ color: "var(--info-text)" }}>
            What to ask
          </p>
          <p style={{ fontSize: 16, fontWeight: 550 }}>
            &ldquo;{normaliseQuestion(unresolved.question)}&rdquo;
          </p>
        </div>
      ) : null}

      <div className="card">
        <span className="availability-tag" data-a={route.availability}>
          {route.availability === "verified-destination"
            ? "Verified destination"
            : route.availability === "guidance-only"
              ? "Guidance only"
              : "Not available"}
        </span>
        <h3 className="section-title" style={{ fontSize: 18, marginTop: 10 }}>
          {route.title}
        </h3>
        <p className="body-text">{route.description}</p>
      </div>

      <div className="stack" style={{ ["--gap" as string]: "10px" }}>
        {route.actions.map((action) =>
          action.href ? (
            <a
              key={action.label}
              className="route-btn external-note"
              href={action.href}
              target={action.external ? "_blank" : undefined}
              rel={action.external ? "noopener noreferrer" : undefined}
              style={{ display: "block", textDecoration: "none" }}
            >
              <strong>{action.label}</strong>
              <span>{action.detail}</span>
              {action.external ? (
                <span className="tiny" style={{ marginTop: 4 }}>
                  Opens an external site. This prototype has no connection to it.
                </span>
              ) : null}
            </a>
          ) : (
            <div key={action.label} className="route-btn" style={{ cursor: "default" }}>
              <strong>{action.label}</strong>
              <span>{action.detail}</span>
            </div>
          )
        )}
      </div>

      <div className="card card--warning">
        <p className="card-label">What this cannot do</p>
        <ul className="checklist">
          {route.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>

      {route.sources.length > 0 ? (
        <details className="disclosure">
          <summary>Where these destinations come from</summary>
          <div className="disclosure-body">
            <ul className="cite-list">
              {route.sources.map((s) => (
                <li key={s.url}>
                  <div className="cite" style={{ padding: "10px 12px" }}>
                    <p style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</p>
                    <p className="tiny">Link checked on {s.verifiedOn}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}
    </>
  );
}

function ReportingBlock() {
  return (
    <div className="card card--flat">
      <p className="card-label" style={{ color: "var(--text-muted)" }}>
        {ADVERSE_EVENT_REPORTING.title}
      </p>
      <p className="tiny" style={{ marginBottom: 12 }}>
        {ADVERSE_EVENT_REPORTING.description}
      </p>
      <div className="stack" style={{ ["--gap" as string]: "8px" }}>
        {ADVERSE_EVENT_REPORTING.actions.map((a) => (
          <a
            key={a.label}
            className="route-btn external-note"
            href={a.href}
            target={a.external ? "_blank" : undefined}
            rel={a.external ? "noopener noreferrer" : undefined}
            style={{ display: "block", textDecoration: "none" }}
          >
            <strong>{a.label}</strong>
            <span>{a.detail}</span>
          </a>
        ))}
      </div>
    </div>
  );
}


/**
 * Confirm a prescriber's NPI.
 *
 * This is a LOOKUP of a number the reader already has - off a prescription
 * label, an after-visit summary, a business card - and never a directory. The
 * registry cannot say who is licensed right now, who takes an insurance, or
 * who is accepting patients, so a "find a doctor near you" built on it would
 * send people to the wrong places. Looking up one number they already hold is
 * the part it can actually support.
 *
 * Two things the UI is careful about:
 *
 *   A successful lookup is not confirmation. One mistyped digit can produce a
 *   valid NPI belonging to somebody else - the check digit cannot catch every
 *   transposition - so the reader is asked to confirm the NAME matches.
 *
 *   An old record is the common failure, not a missing one. Providers attest
 *   their own details, so a phone number certified years ago may be dead. The
 *   attestation age is shown whenever it is over two years.
 */
function NpiLookupBlock() {
  const [npi, setNpi] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const [result, setResult] = useState<NpiResponse | null>(null);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    if (npi.trim().length === 0) return;
    setState("loading");
    track("npi_lookup_submitted", {});
    try {
      const res = await fetch(`/api/provider?npi=${encodeURIComponent(npi.trim())}`);
      setResult((await res.json()) as NpiResponse);
    } catch {
      setResult({
        outcome: { state: "source-unavailable", reason: "The lookup could not be completed." },
        disclaimer: "",
        limitations: [],
        checkedAt: new Date().toISOString(),
      });
    }
    setState("done");
  }

  const outcome = result?.outcome;

  return (
    <div className="card card--flat" style={{ marginTop: 12 }}>
      <p className="card-label" style={{ color: "var(--text-muted)" }}>
        Check a prescriber&rsquo;s NPI
      </p>
      <p className="tiny" style={{ marginBottom: 10 }}>
        Every US prescriber has a 10-digit National Provider Identifier. If you have one from a
        prescription or a visit summary, you can look up what the federal registry lists for it.
        This is not a way to find a new provider.
      </p>

      <form onSubmit={lookup} className="stack" style={{ ["--gap" as string]: "8px" }}>
        <label className="tiny" htmlFor="npi-input">
          NPI number
        </label>
        <input
          id="npi-input"
          className="input"
          inputMode="numeric"
          autoComplete="off"
          placeholder="10 digits"
          value={npi}
          maxLength={20}
          onChange={(e) => setNpi(e.target.value)}
        />
        <button className="btn" type="submit" disabled={state === "loading"}>
          {state === "loading" ? "Checking\u2026" : "Look up"}
        </button>
      </form>

      {outcome ? (
        <div style={{ marginTop: 12 }}>
          {outcome.state === "invalid-npi" ? (
            <p className="tiny">{outcome.reason}</p>
          ) : outcome.state === "not-found" ? (
            <p className="tiny">
              No provider is registered under that NPI. Check the digits against your paperwork.
            </p>
          ) : outcome.state === "source-unavailable" ? (
            <p className="tiny">
              {outcome.reason} This does not mean the NPI is invalid &mdash; the registry could not
              be reached.
            </p>
          ) : (
            <div className="card" style={{ marginTop: 4 }}>
              {outcome.provider.status !== "active" ? (
                <p className="tiny" style={{ color: "var(--warning-text, inherit)" }}>
                  <strong>This NPI is not currently active</strong> in the registry.
                </p>
              ) : null}

              <p style={{ fontSize: 16, marginBottom: 2 }}>
                <strong>{outcome.provider.name || "Name not listed"}</strong>
                {outcome.provider.credential ? `, ${outcome.provider.credential}` : ""}
              </p>
              {outcome.provider.primarySpecialty ? (
                <p className="tiny">
                  Listed specialty: {outcome.provider.primarySpecialty} (chosen by the provider, not
                  a board certification)
                </p>
              ) : null}
              {outcome.provider.practiceLocation ? (
                <p className="tiny" style={{ marginTop: 6 }}>
                  Registered practice location: {outcome.provider.practiceLocation.city ?? "?"},{" "}
                  {outcome.provider.practiceLocation.state ?? "?"}
                  {outcome.provider.practiceLocation.phone
                    ? ` \u00b7 ${outcome.provider.practiceLocation.phone}`
                    : ""}
                </p>
              ) : null}

              {/* The transposition problem, stated where it matters. */}
              <p className="tiny" style={{ marginTop: 10 }}>
                <strong>Check the name above matches who you expect.</strong> A single mistyped
                digit can still produce a valid NPI belonging to a different provider.
              </p>

              {outcome.provider.possiblyStale ? (
                <p className="tiny" style={{ marginTop: 8 }}>
                  This record was last confirmed by the provider
                  {outcome.provider.yearsSinceCertification !== null
                    ? ` about ${outcome.provider.yearsSinceCertification} year${
                        outcome.provider.yearsSinceCertification === 1 ? "" : "s"
                      } ago`
                    : " at an unknown date"}
                  , so the address and phone number may be out of date.
                </p>
              ) : null}

              {result?.disclaimer ? (
                <p className="tiny" style={{ marginTop: 10, opacity: 0.85 }}>
                  {result.disclaimer}
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
