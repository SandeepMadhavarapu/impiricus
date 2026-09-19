"use client";

import { useEffect, useState } from "react";
import { Sheet } from "./Sheet";
import { track } from "@/shared/lib/analytics/client";
import {
  EVIDENCE_LABELS,
  formatCost,
  type CoverageResult,
  type CoverageField,
  type TriState,
} from "@/patient/lib/coverage/types";

interface DirectoryPayer { id: string; name: string }
interface DirectoryPlan { id: string; name: string }
interface DirectoryPharmacy {
  id: string;
  name: string;
  address: string;
  kind: string;
  distanceMiles?: number;
}

/**
 * Loads the insurer, plan and pharmacy pickers from /api/directory.
 *
 * Every list starts empty and stays empty until a directory is licensed and
 * connected, which is a supported state: the form falls back to free text and
 * says so. Nothing here invents a plan name or a pharmacy.
 *
 * The ZIP is sent only to run the lookup. It is not stored by the client, not
 * put in the URL, and not included in anything shared.
 */
function useDirectory(insurer: string, zip: string) {
  const [payers, setPayers] = useState<DirectoryPayer[]>([]);
  const [plans, setPlans] = useState<DirectoryPlan[]>([]);
  const [pharmacies, setPharmacies] = useState<DirectoryPharmacy[]>([]);
  const [pharmacyError, setPharmacyError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/directory?kind=payers")
      .then((r) => (r.ok ? r.json() : { payers: [] }))
      .then((d) => {
        if (!cancelled) setPayers(d.payers ?? []);
      })
      .catch(() => {
        // An unreachable directory is not an error the person needs to see:
        // the field still works as free text.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const match = payers.find((p) => p.name.toLowerCase() === insurer.trim().toLowerCase());
    if (!match) {
      setPlans([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/directory?kind=plans&payerId=${encodeURIComponent(match.id)}`)
      .then((r) => (r.ok ? r.json() : { plans: [] }))
      .then((d) => {
        if (!cancelled) setPlans(d.plans ?? []);
      })
      .catch(() => setPlans([]));
    return () => {
      cancelled = true;
    };
  }, [insurer, payers]);

  useEffect(() => {
    if (zip.length !== 5) {
      setPharmacies([]);
      setPharmacyError(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/directory?kind=pharmacies&zip=${encodeURIComponent(zip)}`)
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => {
        if (cancelled) return;
        setPharmacies(body.pharmacies ?? []);
        setPharmacyError(ok ? null : (body.error ?? null));
      })
      .catch(() => {
        if (!cancelled) setPharmacies([]);
      });
    return () => {
      cancelled = true;
    };
  }, [zip]);

  return { payers, plans, pharmacies, pharmacyError };
}

/**
 * Coverage check.
 *
 * Collects only what actually changes the answer: plan identity, plan year, and
 * the exact fill (strength, form, quantity, days' supply). It never asks for a
 * member ID, a date of birth, or an insurance card photo — a general formulary
 * question does not require any of them, and this prototype has nowhere
 * appropriate to store them.
 *
 * The result renders its evidence state prominently, with every unverified
 * field shown as "Not available" rather than blank or zero.
 */
export function CoverageSheet({
  open,
  onClose,
  slug,
  productName,
  defaultStrength,
  defaultForm,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  productName: string;
  defaultStrength: string;
  defaultForm: string;
}) {
  const [insurer, setInsurer] = useState("");
  const [planName, setPlanName] = useState("");
  const [planYear, setPlanYear] = useState(String(new Date().getFullYear()));
  const [stateCode, setStateCode] = useState("");
  const [quantity, setQuantity] = useState("30");
  const [daysSupply, setDaysSupply] = useState("30");
  const [pharmacyType, setPharmacyType] = useState("retail");

  const [zip, setZip] = useState("");
  const directory = useDirectory(insurer, zip);

  const [result, setResult] = useState<CoverageResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const nextErrors: Record<string, string> = {};
    if (insurer.trim().length < 2) nextErrors.insurer = "Enter your insurer.";
    if (planName.trim().length < 2) nextErrors.planName = "Enter your exact plan name.";
    const year = Number(planYear);
    if (!Number.isInteger(year) || year < 2020 || year > 2100) {
      nextErrors.planYear = "Enter a valid plan year.";
    }
    if (!Number.isInteger(Number(quantity)) || Number(quantity) < 1) {
      nextErrors.quantity = "Enter the quantity on the prescription.";
    }
    if (!Number.isInteger(Number(daysSupply)) || Number(daysSupply) < 1) {
      nextErrors.daysSupply = "Enter the days' supply.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setBusy(true);
    setFailure(null);
    track("coverage_flow_started");

    try {
      const res = await fetch("/api/coverage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          insurer: insurer.trim(),
          planName: planName.trim(),
          planYear: year,
          state: stateCode.trim() || undefined,
          strength: defaultStrength,
          dosageForm: defaultForm,
          quantity: Number(quantity),
          daysSupply: Number(daysSupply),
          pharmacyType,
        }),
      });

      if (!res.ok) {
        setFailure(
          "The coverage check could not be completed. This does not tell us anything about whether the medication is covered."
        );
        return;
      }
      const data: CoverageResult = await res.json();
      setResult(data);
      track("coverage_flow_completed", { evidence_state: data.state });
    } catch {
      setFailure(
        "Network problem. The coverage check did not run. This does not tell us anything about whether the medication is covered."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Check insurance coverage"
      subtitle={productName}
      labelledBy="coverage-title"
    >
      <div className="chat-log">
        {result ? (
          <ResultView result={result} onReset={() => setResult(null)} />
        ) : (
          <>
            <div className="card card--flat">
              <p style={{ fontSize: 15 }}>
                Coverage depends on the exact strength, form, quantity and days&rsquo; supply, not
                just the drug name. We ask for those so the answer is about your actual
                prescription.
              </p>
              <p className="tiny" style={{ marginTop: 8 }}>
                We do not ask for a member ID, date of birth, or a photo of your card. A general
                formulary question does not need them.
              </p>
            </div>

            <form onSubmit={submit} noValidate>
              <div className="card">
                <p className="card-label" style={{ color: "var(--text-muted)" }}>
                  Your plan
                </p>

                {/*
                  Insurer and plan are type-ahead pickers backed by a licensed
                  directory. Until one is connected they stay free-text rather
                  than offering a made-up list of plan names to someone working
                  out whether they can afford a medication. A native datalist
                  does both jobs: suggestions when there is data, a plain text
                  field when there is not.
                */}
                <div className="field">
                  <label htmlFor="cov-insurer">Insurance company</label>
                  <input
                    id="cov-insurer"
                    list={directory.payers.length > 0 ? "cov-payer-options" : undefined}
                    value={insurer}
                    onChange={(e) => setInsurer(e.target.value)}
                    autoComplete="off"
                    aria-invalid={Boolean(errors.insurer)}
                    aria-describedby={errors.insurer ? "err-insurer" : undefined}
                    placeholder="e.g. Blue Cross Blue Shield"
                  />
                  {directory.payers.length > 0 ? (
                    <datalist id="cov-payer-options">
                      {directory.payers.map((p) => (
                        <option key={p.id} value={p.name} />
                      ))}
                    </datalist>
                  ) : null}
                  {errors.insurer ? (
                    <p className="field-error" id="err-insurer">
                      {errors.insurer}
                    </p>
                  ) : null}
                </div>

                <div className="field">
                  <label htmlFor="cov-plan">Exact plan name</label>
                  <p className="hint">
                    Insurers run many plans with different drug lists. The name is printed on your
                    card.
                  </p>
                  <input
                    id="cov-plan"
                    list={directory.plans.length > 0 ? "cov-plan-options" : undefined}
                    value={planName}
                    onChange={(e) => setPlanName(e.target.value)}
                    autoComplete="off"
                    aria-invalid={Boolean(errors.planName)}
                    aria-describedby={errors.planName ? "err-plan" : undefined}
                    placeholder="e.g. Blue Advantage PPO Gold"
                  />
                  {directory.plans.length > 0 ? (
                    <datalist id="cov-plan-options">
                      {directory.plans.map((p) => (
                        <option key={p.id} value={p.name} />
                      ))}
                    </datalist>
                  ) : null}
                  {errors.planName ? (
                    <p className="field-error" id="err-plan">
                      {errors.planName}
                    </p>
                  ) : null}
                </div>

                <div className="field-row">
                  <div className="field">
                    <label htmlFor="cov-year">Plan year</label>
                    <input
                      id="cov-year"
                      inputMode="numeric"
                      value={planYear}
                      onChange={(e) => setPlanYear(e.target.value)}
                      aria-invalid={Boolean(errors.planYear)}
                    />
                    {errors.planYear ? <p className="field-error">{errors.planYear}</p> : null}
                  </div>
                  <div className="field">
                    <label htmlFor="cov-state">State (optional)</label>
                    <input
                      id="cov-state"
                      maxLength={2}
                      value={stateCode}
                      onChange={(e) => setStateCode(e.target.value.toUpperCase())}
                      placeholder="CA"
                    />
                  </div>
                </div>
              </div>

              <div className="card" style={{ marginTop: 14 }}>
                <p className="card-label" style={{ color: "var(--text-muted)" }}>
                  The prescription
                </p>

                <div className="field">
                  <label>Medication</label>
                  <p className="hint" style={{ marginBottom: 0 }}>
                    {productName}: {defaultStrength}, {defaultForm.toLowerCase()}
                  </p>
                </div>

                <div className="field-row" style={{ marginTop: 14 }}>
                  <div className="field">
                    <label htmlFor="cov-qty">Quantity</label>
                    <input
                      id="cov-qty"
                      inputMode="numeric"
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      aria-invalid={Boolean(errors.quantity)}
                    />
                    {errors.quantity ? <p className="field-error">{errors.quantity}</p> : null}
                  </div>
                  <div className="field">
                    <label htmlFor="cov-days">Days&rsquo; supply</label>
                    <input
                      id="cov-days"
                      inputMode="numeric"
                      value={daysSupply}
                      onChange={(e) => setDaysSupply(e.target.value)}
                      aria-invalid={Boolean(errors.daysSupply)}
                    />
                    {errors.daysSupply ? <p className="field-error">{errors.daysSupply}</p> : null}
                  </div>
                </div>

                {/*
                  Pharmacy by ZIP, so someone can pick the one they actually
                  use rather than answer a question about pharmacy categories.
                  Costs differ between pharmacies, so which one matters.
                  Falls back to the category picker until a dataset is
                  connected. The ZIP runs the lookup and is not stored.
                */}
                <div className="field">
                  <label htmlFor="cov-zip">Your ZIP code</label>
                  <p className="hint">
                    Used to find pharmacies near you. It is not saved.
                  </p>
                  <input
                    id="cov-zip"
                    inputMode="numeric"
                    maxLength={5}
                    value={zip}
                    onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))}
                    placeholder="e.g. 22030"
                  />
                  {directory.pharmacyError ? (
                    <p className="field-error">{directory.pharmacyError}</p>
                  ) : null}
                </div>

                {directory.pharmacies.length > 0 ? (
                  <div className="field">
                    <label htmlFor="cov-pharmacy">Pharmacy near you</label>
                    <select
                      id="cov-pharmacy"
                      value={pharmacyType}
                      onChange={(e) => setPharmacyType(e.target.value)}
                    >
                      {directory.pharmacies.map((p) => (
                        <option key={p.id} value={p.kind}>
                          {p.name}
                          {typeof p.distanceMiles === "number" ? ` (${p.distanceMiles} mi)` : ""}
                          {`, ${p.address}`}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="field">
                    <label htmlFor="cov-pharm">Pharmacy type</label>
                    {zip.length === 5 ? (
                      <p className="hint">
                        Pharmacy search is not connected yet, so pick a type for now.
                      </p>
                    ) : null}
                    <select
                      id="cov-pharm"
                      value={pharmacyType}
                      onChange={(e) => setPharmacyType(e.target.value)}
                    >
                      <option value="retail">Retail pharmacy</option>
                      <option value="mail-order">Mail order</option>
                      <option value="specialty">Specialty pharmacy</option>
                      <option value="unspecified">Not sure</option>
                    </select>
                  </div>
                )}
              </div>

              {failure ? (
                <div className="card card--warning" style={{ marginTop: 14 }} role="alert">
                  <p style={{ fontSize: 15 }}>{failure}</p>
                </div>
              ) : null}

              <button
                type="submit"
                className="btn btn--primary btn--block"
                style={{ marginTop: 16 }}
                disabled={busy}
              >
                {busy ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Checking…
                  </>
                ) : (
                  "Check what can be verified"
                )}
              </button>
            </form>
          </>
        )}
      </div>
    </Sheet>
  );
}

function ResultView({ result, onReset }: { result: CoverageResult; onReset: () => void }) {
  return (
    <>
      {result.isSample ? (
        <p className="sample-banner" role="note">
          ⚠ SAMPLE MODE. The result below is fictional demonstration data. It is not from any real
          insurer and must not be used to make decisions.
        </p>
      ) : null}

      <div className="evidence-banner" data-state={result.state} role="status">
        <p className="evidence-state">{EVIDENCE_LABELS[result.state]}</p>
        <p className="evidence-headline">{result.headline}</p>
      </div>

      <div className="card card--flat">
        <p className="card-label" style={{ color: "var(--text-muted)" }}>
          What this answer applies to
        </p>
        <dl className="prov-table">
          <div className="prov-row">
            <dt>Product</dt>
            <dd>{result.scope.product}</dd>
          </div>
          <div className="prov-row">
            <dt>Fill</dt>
            <dd>
              {result.scope.strength} · {result.scope.dosageForm.toLowerCase()} · qty{" "}
              {result.scope.quantity} · {result.scope.daysSupply} days
            </dd>
          </div>
          <div className="prov-row">
            <dt>Plan</dt>
            <dd>
              {result.scope.plan} ({result.scope.planYear})
            </dd>
          </div>
        </dl>
      </div>

      <div>
        <h3 className="section-title" style={{ fontSize: 17 }}>
          What was verified
        </h3>
        <dl className="result-grid">
          <Row label="On the formulary" field={result.formularyListing} render={triState} />
          <Row label="Tier" field={result.tier} render={(v) => v} />
          <Row label="Prior authorisation" field={result.priorAuthorization} render={triState} />
          <Row label="Step therapy" field={result.stepTherapy} render={triState} />
          <Row label="Quantity limits" field={result.quantityLimits} render={(v) => v} />
          <Row label="Pharmacy restrictions" field={result.pharmacyRestrictions} render={(v) => v} />
          <Row label="Effective dates" field={result.effectiveDates} render={(v) => v} />
          <div className="result-row">
            <dt>Your estimated cost</dt>
            <dd data-missing={result.costEstimate ? "false" : "true"}>
              {formatCost(result.costEstimate)}
            </dd>
          </div>
        </dl>
        {result.sourceTimestamp ? (
          <p className="tiny" style={{ marginTop: 8 }}>
            Source: {result.sourceTimestamp}
          </p>
        ) : null}
      </div>

      <div className="card card--warning">
        <p className="card-label">What this does not tell you</p>
        <ul className="checklist">
          {result.caveats.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="section-title" style={{ fontSize: 17 }}>
          What you can do next
        </h3>
        <div className="stack" style={{ ["--gap" as string]: "10px" }}>
          {result.nextSteps.map((step) =>
            step.href ? (
              <a
                key={step.label}
                className="route-btn external-note"
                href={step.href}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: "block", textDecoration: "none" }}
              >
                <strong>{step.label}</strong>
                <span>{step.detail}</span>
              </a>
            ) : (
              <div className="route-btn" key={step.label} style={{ cursor: "default" }}>
                <strong>{step.label}</strong>
                <span>{step.detail}</span>
              </div>
            )
          )}
        </div>
      </div>

      <button type="button" className="btn btn--block" onClick={onReset}>
        Check a different plan or quantity
      </button>
    </>
  );
}

function triState(v: TriState): string {
  return v === "yes" ? "Yes" : v === "no" ? "No" : "Unknown";
}

function Row<T>({
  label,
  field,
  render,
}: {
  label: string;
  field: CoverageField<T>;
  render: (value: T) => string;
}) {
  const missing = field.value === null;
  return (
    <div className="result-row">
      <dt>{label}</dt>
      {/* A missing value renders as "Not available": never blank, never zero. */}
      <dd data-missing={missing ? "true" : "false"}>
        {missing ? "Not available" : render(field.value as T)}
      </dd>
    </div>
  );
}
