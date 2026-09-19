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
  buildHandoffQuestions,
  handoffReasonLabel,
  normaliseQuestion,
  type UnresolvedQuestion,
} from "@/doctor/lib/handoff";

/**
 * Provider connection.
 *
 * First it asks WHO the person actually wants, because "connect me with a
 * provider" means four different things. Then it offers the strongest real
 * route for that choice — and says plainly when there is none.
 *
 * The question-summary builder is entirely local. Nothing is transmitted, so
 * there is no recipient to confirm and no personal information to handle. When
 * a referral integration is configured, that is where a confirm-before-send
 * step belongs — see docs/INTEGRATIONS.md.
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
                  {handoffReasonLabel(unresolved.reason)} It stays on your device — this site does
                  not send it to anyone.
                </p>
              </div>
            ) : null}

            <div className="card card--flat">
              <p style={{ fontSize: 15 }}>Who would you like to talk to?</p>
              <p className="tiny" style={{ marginTop: 8 }}>
                Different questions need different people. A pharmacist can usually answer a
                medication question today, for free.
              </p>
            </div>

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
            productName={productName}
            unresolved={unresolved}
            onBack={() => setIntent(null)}
          />
        )}
      </div>
    </Sheet>
  );
}

function RouteView({
  route,
  productName,
  unresolved,
  onBack,
}: {
  route: ProviderRoute;
  productName: string;
  unresolved: UnresolvedQuestion | null;
  onBack: () => void;
}) {
  return (
    <>
      <button type="button" className="btn btn--small" onClick={onBack} style={{ alignSelf: "flex-start" }}>
        ← Choose someone else
      </button>

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

      {route.intent === "existing-clinician" || route.intent === "pharmacist" ? (
        <QuestionBuilder productName={productName} unresolved={unresolved} />
      ) : null}

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

/**
 * Local-only question list.
 *
 * The user edits it, then copies or prints it. It never leaves the device, so
 * the page can say so without qualification.
 */
function QuestionBuilder({
  productName,
  unresolved,
}: {
  productName: string;
  unresolved: UnresolvedQuestion | null;
}) {
  // The carried question is first in the list — it is why they are here.
  const [questions, setQuestions] = useState<string[]>(() =>
    buildHandoffQuestions(productName, unresolved)
  );
  const [copied, setCopied] = useState(false);
  const carriedFirst = Boolean(unresolved && normaliseQuestion(unresolved.question));

  const text = questions.filter((q) => q.trim()).join("\n\n");

  return (
    <div className="card">
      <p className="card-label" style={{ color: "var(--text-muted)" }}>
        Questions to bring with you
      </p>
      <p className="tiny" style={{ marginBottom: 12 }}>
        Edit or delete anything. This list stays on your device — it is not sent anywhere, and this
        site does not contact anyone on your behalf.
      </p>

      {questions.map((q, i) => (
        <div className="question-item" key={i}>
          {carriedFirst && i === 0 ? (
            <span className="cite-ref" style={{ alignSelf: "center" }}>
              YOURS
            </span>
          ) : null}
          <textarea
            value={q}
            rows={2}
            aria-label={`Question ${i + 1}`}
            onChange={(e) => {
              const next = [...questions];
              next[i] = e.target.value;
              setQuestions(next);
              setCopied(false);
            }}
          />
          <button
            type="button"
            className="icon-btn"
            style={{ minWidth: 36, minHeight: 36 }}
            aria-label={`Remove question ${i + 1}`}
            onClick={() => setQuestions(questions.filter((_, j) => j !== i))}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ))}

      <div className="btn-row" style={{ marginTop: 14 }}>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => setQuestions([...questions, ""])}
        >
          Add a question
        </button>
        <button
          type="button"
          className="btn btn--small btn--primary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          Copy list
        </button>
      </div>
      <p className="share-status" role="status" aria-live="polite">
        {copied ? "Copied to your clipboard." : " "}
      </p>
    </div>
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
