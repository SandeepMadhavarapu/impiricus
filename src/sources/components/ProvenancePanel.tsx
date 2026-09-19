import type { SourceRecord } from "@/sources/lib/content/types";
import type { IntegrationState } from "@/shared/lib/config";

/**
 * Where this content came from, and what is actually connected.
 *
 * Both halves are deliberately public. Someone should be able to tell, without
 * asking, that the coverage feature is not wired to a payer and that no
 * clinician has reviewed the medication content.
 */
export function ProvenancePanel({
  source,
  integrations,
}: {
  source: SourceRecord;
  integrations: IntegrationState[];
}) {
  return (
    <section className="share-section" aria-labelledby="prov-heading">
      <h2 className="section-title" id="prov-heading">
        Where this comes from
      </h2>

      <div className="card card--flat">
        <dl className="prov-table">
          <div className="prov-row">
            <dt>Product</dt>
            <dd>
              {source.product.brandName} · {source.product.strength.join(", ")} ·{" "}
              {source.product.dosageForm}
            </dd>
          </div>
          <div className="prov-row">
            <dt>NDC</dt>
            <dd>{source.product.productNdc}</dd>
          </div>
          <div className="prov-row">
            <dt>Labeler</dt>
            <dd>{source.product.labelerName}</dd>
          </div>
          <div className="prov-row">
            <dt>Document</dt>
            <dd>
              SPL set {source.document.splSetId.slice(0, 8)}… version {source.document.splVersion}
            </dd>
          </div>
          <div className="prov-row">
            <dt>Label effective</dt>
            <dd>{source.document.effectiveDate}</dd>
          </div>
          <div className="prov-row">
            <dt>Published (DailyMed)</dt>
            <dd>{source.document.dailyMedPublishedDate}</dd>
          </div>
          <div className="prov-row">
            <dt>Retrieved on</dt>
            <dd>{new Date(source.provenance.retrievedAt).toUTCString()}</dd>
          </div>
          <div className="prov-row">
            <dt>Clinically reviewed</dt>
            <dd>
              <strong>No clinical review has been performed.</strong> &ldquo;Retrieved&rdquo; means
              downloaded from a public FDA source. It does not mean a clinician checked it.
            </dd>
          </div>
        </dl>

        <details className="disclosure">
          <summary>Source APIs ({source.provenance.sources.length})</summary>
          <div className="disclosure-body">
            <ul className="cite-list">
              {source.provenance.sources.map((s) => (
                <li key={s.url}>
                  <div className="cite" style={{ padding: "10px 12px" }}>
                    <p style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</p>
                    <p className="tiny">{s.publisher}</p>
                    {s.lastUpdated ? <p className="tiny">Source last updated: {s.lastUpdated}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </details>
      </div>

      <h3 className="section-title" style={{ fontSize: 17, marginTop: 22 }}>
        What is actually connected
      </h3>
      <div className="card card--flat">
        <dl className="prov-table">
          {integrations.map((integration) => (
            <div className="prov-row" key={integration.id}>
              <dt>
                <span className="status-dot" data-s={integration.status} aria-hidden="true" />
                {integration.name}
              </dt>
              <dd>
                <span className="visually-hidden">{integration.status}: </span>
                {integration.capability}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
