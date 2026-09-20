import Link from "next/link";
import { DEFAULT_MEDICATION_SLUG } from "@/sources/lib/content/registry";
import { AppBar } from "@/shared/components/AppBar";

/**
 * Unknown medication route.
 *
 * This page exists to make one thing impossible: quietly showing a different
 * medication than the one the link asked for. A wrong-drug answer is the most
 * damaging failure this product could produce, so an unknown slug is a dead end
 * by design.
 */
export default function NotFound() {
  return (
    <main className="page" id="main">
      <AppBar subtitle="Your medication guide" />
      <div className="med-header">
        <p className="eyebrow">Link not recognised</p>
        <h1 className="med-title">We could not find that medication</h1>
        <p className="med-headline">
          The link may be mistyped, or it may point to a medication this prototype does not cover.
        </p>
      </div>

      <div className="card card--warning" style={{ marginTop: 18 }}>
        <p className="card-label">Why we are not guessing</p>
        <p className="body-text">
          Rather than show you the closest match, we show nothing. Medication information is only
          useful if it is about the right product: the right drug, at the right strength, in the
          right form.
        </p>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <p className="body-text">
          To look up any medication, DailyMed publishes the FDA-approved label for every product
          marketed in the United States.
        </p>
        <div className="btn-row" style={{ marginTop: 14 }}>
          <a
            className="btn"
            href="https://dailymed.nlm.nih.gov/dailymed/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Search DailyMed
          </a>
          <Link className="btn btn--primary" href={`/medications/${DEFAULT_MEDICATION_SLUG}`}>
            See the example medication
          </Link>
        </div>
      </div>

      <footer className="site-footer">
          <p style={{ marginTop: 10 }}>In a medical emergency in the US:</p>
          {/*
           * F-05: all three numbers are dialable, equally sized targets.
           *
           * Previously 911 was plain text, Poison Help was a 38px target that
           * collapsed to 17px on a phone, and 988 - the crisis line, on a page
           * whose boxed warning concerns neuropsychiatric events - was a 21x17
           * target at 13px. That is precision tapping for the reader least able
           * to do it.
           *
           * Rendered as a list of tel: links so each has a >=44px hit area at
           * every width, with the purpose beside the number rather than hidden
           * behind it.
           */}
          <ul className="emergency-list">
            <li>
              <a className="emergency-tel" href="tel:911">
                <span className="emergency-tel__number">911</span>
                <span className="emergency-tel__what">Emergency services</span>
              </a>
            </li>
            <li>
              <a className="emergency-tel" href="tel:18002221222">
                <span className="emergency-tel__number">1-800-222-1222</span>
                <span className="emergency-tel__what">Poison Help &mdash; suspected overdose</span>
              </a>
            </li>
            <li>
              <a className="emergency-tel" href="tel:988">
                <span className="emergency-tel__number">988</span>
                <span className="emergency-tel__what">Mental-health crisis support (call or text)</span>
              </a>
            </li>
          </ul>
      </footer>
    </main>
  );
}
