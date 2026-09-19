/**
 * A SYNTHETIC SPL document.
 *
 * Hand-built to exercise structure that matters and that a real fetch cannot be
 * relied upon to provide on demand: nested subsections, a dosing table with a
 * population column, two products in one document, a salt with a distinct
 * active moiety, and a patient-directed section.
 *
 * It is not a real drug label. Nothing here should be used as data.
 */
export const SYNTHETIC_SPL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<document xmlns="urn:hl7-org:v3">
  <id root="synthetic-document-id"/>
  <title>TESTDRUG (TESTOLOL SUCCINATE) TABLET [SYNTHETIC LABS]</title>
  <effectiveTime value="20260101"/>
  <setId root="00000000-0000-0000-0000-000000000000"/>
  <versionNumber value="3"/>
  <author>
    <assignedEntity>
      <representedOrganization>
        <name>Synthetic Labs, Inc.</name>
      </representedOrganization>
    </assignedEntity>
  </author>
  <component>
    <structuredBody>

      <component>
        <section ID="PDE">
          <code code="48780-1" codeSystem="2.16.840.1.113883.6.1" displayName="SPL PRODUCT DATA ELEMENTS SECTION"/>
          <subject>
            <manufacturedProduct>
              <manufacturedProduct>
                <code code="99999-001" codeSystem="2.16.840.1.113883.6.69"/>
                <name>TESTDRUG</name>
                <formCode code="C42931" displayName="TABLET, FILM COATED"/>
                <ingredient classCode="ACTIM">
                  <quantity>
                    <numerator value="10" unit="mg"/>
                    <denominator value="1" unit="1"/>
                  </quantity>
                  <ingredientSubstance>
                    <name>TESTOLOL SUCCINATE</name>
                    <activeMoiety><activeMoiety><name>TESTOLOL</name></activeMoiety></activeMoiety>
                  </ingredientSubstance>
                </ingredient>
                <ingredient classCode="IACT">
                  <ingredientSubstance><name>LACTOSE</name></ingredientSubstance>
                </ingredient>
                <asContent>
                  <containerPackagedProduct>
                    <code code="99999-001-30"/>
                  </containerPackagedProduct>
                </asContent>
              </manufacturedProduct>
              <consumedIn>
                <substanceAdministration>
                  <routeCode code="C38288" displayName="ORAL"/>
                </substanceAdministration>
              </consumedIn>
            </manufacturedProduct>
          </subject>
          <subject>
            <manufacturedProduct>
              <manufacturedProduct>
                <code code="99999-002" codeSystem="2.16.840.1.113883.6.69"/>
                <name>TESTDRUG</name>
                <formCode code="C42904" displayName="GRANULE"/>
                <ingredient classCode="ACTIM">
                  <quantity>
                    <numerator value="4" unit="mg"/>
                    <denominator value="1" unit="1"/>
                  </quantity>
                  <ingredientSubstance>
                    <name>TESTOLOL SUCCINATE</name>
                    <activeMoiety><activeMoiety><name>TESTOLOL</name></activeMoiety></activeMoiety>
                  </ingredientSubstance>
                </ingredient>
                <asContent>
                  <containerPackagedProduct>
                    <code code="99999-002-30"/>
                  </containerPackagedProduct>
                </asContent>
              </manufacturedProduct>
              <consumedIn>
                <substanceAdministration>
                  <routeCode code="C38288" displayName="ORAL"/>
                </substanceAdministration>
              </consumedIn>
            </manufacturedProduct>
          </subject>
        </section>
      </component>

      <component>
        <section>
          <code code="34068-7" codeSystem="2.16.840.1.113883.6.1" displayName="DOSAGE &amp; ADMINISTRATION SECTION"/>
          <title>2 DOSAGE AND ADMINISTRATION</title>
          <text>
            <paragraph>Administer once daily.</paragraph>
            <table>
              <caption>Table 1: Recommended Dosage by Age</caption>
              <thead><tr><th>Age</th><th>Dose</th></tr></thead>
              <tbody>
                <tr><td>Adults 15 years and older</td><td>one 10 mg tablet</td></tr>
                <tr><td>Children 2 to 5 years</td><td>one 4 mg granule packet</td></tr>
              </tbody>
            </table>
          </text>
          <component>
            <section>
              <code code="34068-7" codeSystem="2.16.840.1.113883.6.1"/>
              <title>2.1 Renal Impairment</title>
              <text><paragraph>No adjustment required.</paragraph></text>
            </section>
          </component>
        </section>
      </component>

      <component>
        <section>
          <code code="42231-1" codeSystem="2.16.840.1.113883.6.1" displayName="SPL MEDGUIDE SECTION"/>
          <title>MEDICATION GUIDE</title>
          <text><paragraph>Patient-directed guidance text.</paragraph></text>
        </section>
      </component>

    </structuredBody>
  </component>
</document>`;
