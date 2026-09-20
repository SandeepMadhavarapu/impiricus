"use client";

import { useEffect, useRef, useState } from "react";
import { Sheet } from "./Sheet";
import { track } from "@/shared/lib/analytics/client";
import {
  EVIDENCE_LABELS,
  formatCost,
  type CoverageResult,
  type CoverageField,
  type TriState,
} from "@/patient/lib/coverage/types";

interface DirectoryPayer {
  id: string;
  name: string;
  planCount: number;
  /** "plan-name" when the query matched a plan, not the company. */
  matchedVia?: "organization" | "plan-name";
  /** The plan that caused a "plan-name" match. An example, never their plan. */
  matchedPlanExample?: string;
}
interface DirectoryPlan {
  id: string;
  name: string;
  label: string;
  contractId: string;
  planId: string;
  segmentId: string;
}
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

  // Narrows server-side as the person types: 525 organizations is more than
  // a picker should ship at once.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/api/directory?kind=payers&q=${encodeURIComponent(insurer)}`)
        .then((r) => (r.ok ? r.json() : { payers: [] }))
        .then((d) => {
          if (!cancelled) setPayers(d.payers ?? []);
        })
        .catch(() => {
          // An unreachable directory is not an error the person needs to see:
          // the field still works as free text.
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [insurer]);

  const matchedPayer =
    payers.find((p) => p.name.toLowerCase() === insurer.trim().toLowerCase()) ?? null;

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

  return { payers, plans, pharmacies, pharmacyError, matchedPayer };
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
  /** Exact contract-plan-segment key when the plan came from the directory. */
  const [planKey, setPlanKey] = useState("");
  const directory = useDirectory(insurer, zip);

  const [result, setResult] = useState<CoverageResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * F-03: announcing and reaching a validation failure.
   *
   * Errors were rendered per field with correct aria-invalid and
   * aria-describedby, but nothing told a screen-reader user that submission
   * had failed and focus stayed on the submit button. On a phone the errors
   * are also usually scrolled off the top of the sheet by then.
   *
   * `errorSummary` is an assertive live region, and focus moves to the first
   * invalid input - which scrolls it into view natively and puts the caret
   * where the correction has to happen, above the on-screen keyboard.
   */
  const [errorSummary, setErrorSummary] = useState<string | null>(null);
  /** Field to focus after the next commit, or null. */
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const fieldRefs = useRef<Record<string, HTMLInputElement | HTMLSelectElement | null>>({});
  /** Submit order, so "first invalid" means first on screen, not first in an object. */
  const FIELD_ORDER = ["insurer", "planName", "planYear", "quantity", "daysSupply"] as const;

  /**
   * Moves focus to the first invalid field after a failed submit.
   *
   * Runs post-commit, so the ref is attached. `preventScroll` then an explicit
   * centred scroll, because on a phone the browser's default focus scroll
   * often parks the field directly under the on-screen keyboard - the reader
   * hears the error, tabs to fix it, and cannot see what they are typing.
   */
  useEffect(() => {
    if (!focusTarget) return;
    const el = fieldRefs.current[focusTarget];
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    setFocusTarget(null);
  }, [focusTarget]);

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
    const invalidKeys = FIELD_ORDER.filter((k) => nextErrors[k]);
    if (invalidKeys.length > 0) {
      const count = invalidKeys.length;
      setErrorSummary(
        `${count} ${count === 1 ? "field needs" : "fields need"} attention before this can be checked.`
      );
      // Which field to focus is decided here; MOVING focus happens in an
      // effect, after React has committed. A requestAnimationFrame callback
      // can run before the commit, and the inline ref callbacks are re-invoked
      // with null on every render, so the map is briefly empty at that point.
      setFocusTarget(invalidKeys[0]!);
      return;
    }
    setErrorSummary(null);
    setFocusTarget(null);

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
          // Present only when the plan was chosen from the CMS directory. A
          // typed name is not an identity, so the request says which it is.
          planKey: planKey || undefined,
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
              {/*
                Assertive so the failure interrupts; it is the direct result of
                the user's own submit, which is exactly when interruption is
                wanted. Rendered above the fields so that following it leads
                down into the form rather than back up past it.
              */}
              <p className="visually-hidden" role="alert" aria-live="assertive">
                {errorSummary ?? ""}
              </p>
              {errorSummary ? (
                <p className="form-error-summary" role="note">
                  {errorSummary}
                </p>
              ) : null}
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
                      ref={(el) => { fieldRefs.current["insurer"] = el; }}
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
                        <option key={p.id} value={p.name}>
                          {p.matchedVia === "plan-name" && p.matchedPlanExample
                            ? `offers ${p.matchedPlanExample}`
                            : undefined}
                        </option>
                      ))}
                    </datalist>
                  ) : null}
                  {/*
                    Several insurers share a brand: typing "humana" matches a
                    dozen legal entities, each running different plans. The
                    form will not guess which, so it says so rather than
                    leaving the plan picker mysteriously inert.
                  */}
                  {directory.payers.length > 0 && !directory.matchedPayer && insurer.trim() ? (
                    <p className="hint">
                      {directory.payers.length} insurer
                      {directory.payers.length === 1 ? "" : "s"} match that. Pick the exact one from
                      the list to choose your plan.
                      {/*
                        The name on a Part D card is usually the plan, not the
                        company that files it. "AARP" appears in 496 plan names
                        and no company name, so without this the most
                        recognisable brand in Part D looked like a typo.
                      */}
                      {directory.payers.some((p) => p.matchedVia === "plan-name") ? (
                        <>
                          {" "}
                          Some of these matched a plan name rather than the company name &mdash; the
                          name on your card is often the plan.
                        </>
                      ) : null}
                    </p>
                  ) : null}
                  {errors.insurer ? (
                    <p className="field-error" id="err-insurer">
                      {errors.insurer}
                    </p>
                  ) : null}
                </div>

                {/*
                  A plan NAME cannot identify a plan: 39 in the current CMS
                  release share the name "AARP Medicare Rx Preferred from UHC
                  (PDP)". Once an insurer is matched, this becomes a real
                  picker whose value is the contract-plan-segment key, and
                  every option shows those ids so someone can match the card
                  in their hand. Free text stays available for an insurer we
                  do not have, where a typed name is all there is.
                */}
                {directory.plans.length > 0 ? (
                  <div className="field">
                    <label htmlFor="cov-plan-select">Your plan</label>
                    <p className="hint">
                      {directory.plans.length} plan
                      {directory.plans.length === 1 ? "" : "s"} from this insurer. The codes in
                      brackets are printed on your card.
                    </p>
                    <select
                      id="cov-plan-select"
                      value={planKey}
                      onChange={(e) => {
                        setPlanKey(e.target.value);
                        const hit = directory.plans.find((p) => p.id === e.target.value);
                        // The name still travels for display, but the key is
                        // what identifies the plan.
                        setPlanName(hit ? hit.name : "");
                      }}
                      aria-invalid={Boolean(errors.planName)}
                    >
                      <option value="">Select your plan</option>
                      {directory.plans.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    {errors.planName ? <p className="field-error">{errors.planName}</p> : null}
                  </div>
                ) : (
                  <div className="field">
                    <label htmlFor="cov-plan">Exact plan name</label>
                    <p className="hint">
                      Insurers run many plans with different drug lists. The name is printed on your
                      card.
                    </p>
                    <input
                      id="cov-plan"
                      ref={(el) => { fieldRefs.current["planName"] = el; }}
                      value={planName}
                      onChange={(e) => setPlanName(e.target.value)}
                      autoComplete="off"
                      aria-invalid={Boolean(errors.planName)}
                      aria-describedby={errors.planName ? "err-plan" : undefined}
                      placeholder="e.g. Blue Advantage PPO Gold"
                    />
                    {errors.planName ? (
                      <p className="field-error" id="err-plan">
                        {errors.planName}
                      </p>
                    ) : null}
                  </div>
                )}

                <div className="field-row">
                  <div className="field">
                    <label htmlFor="cov-year">Plan year</label>
                    <input
                      id="cov-year"
                      ref={(el) => { fieldRefs.current["planYear"] = el; }}
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
                      ref={(el) => { fieldRefs.current["quantity"] = el; }}
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
                      ref={(el) => { fieldRefs.current["daysSupply"] = el; }}
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
