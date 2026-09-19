/**
 * Demo plans.
 *
 * Every identifier here was read out of the live CMS 2026-08 release, not
 * chosen from a brochure. Each exists to exercise a specific correctness
 * question rather than to pad a count.
 */
export interface DemoPlan {
  contractId: string;
  planId: string;
  segmentId: string;
  planYear: number;
  label: string;
  exercises: string;
}

export const DEMO_PLANS: DemoPlan[] = [
  {
    contractId: "S5820",
    planId: "034",
    segmentId: "000",
    planYear: 2026,
    label: "AARP Medicare Rx Preferred from UHC (PDP) - UnitedHealthcare, formulary 00026000",
    exercises:
      "Real utilisation management on an exact product match: Ozempic (RXCUI 2398842) is tier 3 with " +
      "prior authorisation AND a quantity limit of 3 per 28 days. Also demonstrates that a plan NAME is " +
      "not an identifier - S5820-034, S5820-035 and S5820-036 all carry the name " +
      "'AARP Medicare Rx Preferred from UHC (PDP)'.",
  },
  {
    contractId: "H0034",
    planId: "001",
    segmentId: "000",
    planYear: 2026,
    label: "Hamaspik Medicare Select (HMO D-SNP), formulary 00026303",
    exercises:
      "Brand versus generic. Formulary 00026303 is the ONLY one in the entire 2026-08 release that lists " +
      "the BRANDED concepts for Singulair (153892) and Toprol XL (866438), both at tier 1 with no " +
      "restrictions. Generic montelukast concepts appear on hundreds of formularies. A generic listing " +
      "is not a brand listing, and this plan is the proof.",
  },
];
