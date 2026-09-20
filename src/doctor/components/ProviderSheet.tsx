"use client";

import { useState } from "react";
import { Sheet } from "@/patient/components/Sheet";
import { ReceiveGuide } from "@/patient/components/ReceiveGuide";
import Link from "next/link";
import { track } from "@/shared/lib/analytics/client";
import {
  PROVIDER_ROUTES,
  ADVERSE_EVENT_REPORTING,
  type ProviderIntent,
  type ProviderRoute,
} from "@/doctor/lib/providers/routes";
import { NearbyClinicians } from "@/doctor/components/NearbyClinicians";
import { PATIENT_SPECIALTIES, LISTING_MEANS } from "@/doctor/lib/providers/specialties";
import {
  handoffReasonLabel,
  normaliseQuestion,
  type UnresolvedQuestion,
} from "@/doctor/lib/handoff";

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
            <Link className="btn btn--block" href="/receive">Receive guide with sound</Link>
          </>
        ) : (
          <RouteView
            route={route}
            unresolved={unresolved}
            onBack={() => setIntent(null)}
          />
        )}
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
      <p id="account-status" className="tiny" style={{ marginBottom: 12 }}>
        Sign in to connect with your own doctor or prescriber. Account access is coming soon.
      </p>
      <div className="btn-row">
        <button type="button" className="btn btn--primary btn--small" disabled aria-describedby="account-status">
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

      {route.intent === "existing-clinician" ? <><AccountBlock /><ReceiveGuide embedded /></> : null}

      {/*
        Real clinicians, above the national directories rather than instead of
        them: those cover the whole country and answer sliding-scale and
        Medicare questions this cannot. This goes first because a phone number
        for a practice a few streets away is a stronger first step than another
        search box on another site.
      */}
      {route.intent === "new-provider" ? (
        <NearbyClinicians specialties={PATIENT_SPECIALTIES} listingMeans={LISTING_MEANS} />
      ) : null}

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
