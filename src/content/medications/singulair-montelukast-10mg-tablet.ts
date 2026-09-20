import type { MedicationRecord } from "@/lib/content/types";

/**
 * Plain-language layer for SINGULAIR (montelukast sodium) 10 mg film-coated
 * tablet, NDA 020829.
 *
 * AUTHORING RULES for this file:
 *  - Every section cites at least one retrieved source section, and every
 *    citation quote must be a literal substring of that section's text. This is
 *    enforced by tests/content.test.ts, so a drifting quote fails the build.
 *  - Plain text restates the label. It does not add effectiveness percentages,
 *    side-effect frequencies, comparisons, or recommendations that the label
 *    does not make.
 *  - Where the label qualifies a statement ("not well understood", "cannot be
 *    directly compared"), the qualification is preserved rather than dropped.
 *  - Nothing here tells a reader to start, stop, or change a medication.
 */
export const singulair10mgTablet: MedicationRecord = {
  slug: "singulair-montelukast-10mg-tablet",
  sourceRecordId: "singulair-montelukast-10mg-tablet",

  headline:
    "A once-daily tablet used to help prevent asthma symptoms, prevent exercise-triggered breathing problems, and relieve allergy symptoms — carrying an FDA boxed warning about serious mental-health side effects.",

  scopeNote:
    "This page covers the 10 mg film-coated tablet only (the adult and 15-and-older strength). The same FDA label also covers 4 mg and 5 mg chewable tablets and 4 mg oral granules, which are different products with different dosing. Information here should not be applied to those forms.",

  sections: [
    {
      id: "boxed-warning",
      title: "FDA Boxed Warning: serious mental-health and behavior changes",
      emphasis: "critical",
      plain: [
        "This medication carries a boxed warning — the FDA's most serious type of warning — about serious neuropsychiatric events, meaning changes in mood, thinking, or behavior.",
        "The label lists reported events including agitation, aggression, depression, sleep disturbances, and suicidal thoughts and behavior, including suicide.",
        "The FDA label states that because of this risk, the benefits may not outweigh the risks for some people — particularly when symptoms are mild and could be treated with other options.",
        "If you or someone taking this medication notices changes in behavior, new mental-health symptoms, or suicidal thoughts, the label directs patients to stop the medication and contact a healthcare provider immediately.",
      ],
      detail: [
        "The label states that the mechanisms behind these events are not currently well understood.",
        "For allergic rhinitis specifically, the label instructs prescribers to reserve this medication for people who have not responded to, or cannot tolerate, alternative therapies.",
      ],
      citations: [
        {
          sectionId: "boxed_warning",
          quote:
            "Serious neuropsychiatric (NP) events have been reported with the use of SINGULAIR.",
        },
        {
          sectionId: "boxed_warning",
          quote:
            "included, but were not limited to, agitation, aggression, depression, sleep disturbances, suicidal thoughts and behavior (including suicide)",
        },
        {
          sectionId: "boxed_warning",
          quote:
            "Because of the risk of NP events, the benefits of SINGULAIR may not outweigh the risks in some patients, particularly when the symptoms of disease may be mild and adequately treated with alternative therapies.",
        },
        {
          sectionId: "boxed_warning",
          quote:
            "The mechanisms underlying NP events associated with SINGULAIR use are currently not well understood",
        },
      ],
    },

    {
      id: "what-it-is",
      title: "What is this medication?",
      emphasis: "normal",
      plain: [
        "Montelukast, sold under the brand name Singulair, is a leukotriene receptor antagonist. It is taken by mouth as a tablet.",
        "Leukotrienes are substances released by cells in your body that contribute to airway swelling, tightening of airway muscles, and allergy symptoms. This medication blocks a receptor those substances act on.",
        "It is a long-term control medication. It is not a rescue inhaler and does not work quickly to open the airways during an attack.",
      ],
      detail: [
        "The 10 mg tablet is described in the label as a beige, rounded square-shaped, film-coated tablet marked MSD 117 on one side and SINGULAIR on the other.",
      ],
      citations: [
        {
          sectionId: "indications_and_usage",
          quote: "SINGULAIR is a leukotriene receptor antagonist indicated for",
        },
        {
          sectionId: "mechanism_of_action",
          quote:
            "In asthma, leukotriene-mediated effects include airway edema, smooth muscle contraction, and altered cellular activity associated with the inflammatory process.",
        },
        {
          sectionId: "dosage_forms_and_strengths",
          quote:
            "Tablets: 10 mg, beige, rounded square-shaped, film-coated tablets, with code MSD 117 on one side and SINGULAIR on the other.",
        },
      ],
    },

    {
      id: "what-it-treats",
      title: "What is it approved to treat?",
      emphasis: "normal",
      plain: [
        "Asthma — to help prevent and manage asthma over time, in people 12 months of age and older.",
        "Exercise-induced bronchoconstriction (EIB) — to help prevent breathing problems brought on by exercise, in people 6 years of age and older.",
        "Allergic rhinitis — to relieve symptoms of seasonal allergies (age 2 and older) and year-round allergies (age 6 months and older).",
        "For allergy symptoms, the label says to reserve this medication for people who have an inadequate response to, or cannot tolerate, other treatments.",
      ],
      detail: [
        "These approved age ranges apply to the medication across all of its forms. The 10 mg tablet covered by this page is the strength the label specifies for people 15 years and older; younger patients use the chewable tablets or oral granules.",
      ],
      citations: [
        {
          sectionId: "indications_and_usage",
          quote:
            "Prophylaxis and chronic treatment of asthma in patients 12 months of age and older",
        },
        {
          sectionId: "indications_and_usage",
          quote:
            "Acute prevention of exercise-induced bronchoconstriction (EIB) in patients 6 years of age and older",
        },
        {
          sectionId: "indications_and_usage",
          quote:
            "seasonal allergic rhinitis (SAR) in patients 2 years of age and older, and perennial allergic rhinitis (PAR) in patients 6 months of age and older",
        },
        {
          sectionId: "indications_and_usage",
          quote:
            "reserve use for patients who have an inadequate response or intolerance to alternative therapies",
        },
        {
          sectionId: "dosage_and_administration",
          quote: "15 years and older: one 10-mg tablet",
        },
      ],
    },

    {
      id: "limitations",
      title: "Important limitations — what it does not do",
      emphasis: "warning",
      plain: [
        "This medication is not indicated to treat an acute asthma attack. It is not a substitute for a rescue inhaler.",
        "The label instructs that people taking it should have appropriate rescue medication available.",
        "It should not be abruptly substituted for inhaled or oral corticosteroids.",
        "People with known aspirin sensitivity should continue to avoid aspirin and NSAIDs while taking it.",
      ],
      citations: [
        {
          sectionId: "indications_and_usage",
          quote: "SINGULAIR is not indicated for the treatment of an acute asthma attack.",
        },
        {
          sectionId: "warnings_and_cautions",
          quote: "Advise patients to have appropriate rescue medication available",
        },
        {
          sectionId: "warnings_and_cautions",
          quote:
            "Do not abruptly substitute SINGULAIR for inhaled or oral corticosteroids",
        },
        {
          sectionId: "warnings_and_cautions",
          quote:
            "Patients with known aspirin sensitivity should continue to avoid aspirin or non-steroidal anti-inflammatory agents while taking SINGULAIR",
        },
      ],
    },

    {
      id: "common-side-effects",
      title: "Common side effects",
      emphasis: "normal",
      plain: [
        "The label lists these as the most common adverse reactions reported at 5% or more, and more often than with placebo: upper respiratory infection, fever, headache, sore throat, cough, abdominal pain, diarrhea, ear infection, influenza, runny nose, sinusitis, and ear inflammation.",
        "An important caveat from the label itself: rates seen in clinical trials cannot be directly compared with rates from other drugs' trials, and may not reflect what happens in everyday practice.",
      ],
      detail: [
        "Being listed as an adverse reaction does not by itself establish that the medication caused it. For example, in the adult and adolescent asthma trials the label reports headache in 18.4% of people taking the medication and 18.1% of people taking placebo — a difference far smaller than the raw number alone suggests.",
        "This page does not list every reported side effect. The full label and Medication Guide, linked below, contain the complete list.",
      ],
      citations: [
        {
          sectionId: "adverse_reactions",
          quote:
            "upper respiratory infection, fever, headache, pharyngitis, cough, abdominal pain, diarrhea, otitis media, influenza, rhinorrhea, sinusitis, otitis",
        },
        {
          sectionId: "adverse_reactions",
          quote:
            "Because clinical trials are conducted under widely varying conditions, adverse reaction rates observed in the clinical trials of a drug cannot be directly compared to rates in the clinical trials of another drug and may not reflect the rates observed in clinical practice.",
        },
        {
          sectionId: "adverse_reactions",
          quote: "Headache Dizziness 18.4 1.9 18.1 1.4",
        },
      ],
    },

    {
      id: "serious-risks",
      title: "Serious risks to understand",
      emphasis: "warning",
      plain: [
        "Mental-health and behavior changes. See the boxed warning above — this is the most serious identified risk. The label reports these events in adults, adolescents, and children, both in people who had a previous psychiatric history and people who did not.",
        "The label states it is difficult to identify who is at risk, or to quantify how large the risk is.",
        "Systemic eosinophilia, sometimes with features of vasculitis consistent with Churg-Strauss syndrome, has been reported. The label notes these events have sometimes been associated with reducing oral corticosteroid therapy.",
      ],
      detail: [
        "The label notes that in many cases symptoms resolved after stopping the medication, but that in some cases symptoms persisted after it was discontinued.",
      ],
      citations: [
        {
          sectionId: "warnings_and_cautions",
          quote:
            "NP events have been reported in adult, adolescent, and pediatric patients with and without a previous history of psychiatric disorder.",
        },
        {
          sectionId: "warnings_and_cautions",
          quote:
            "it is difficult to identify risk factors for or quantify the risk of NP events with SINGULAIR use",
        },
        {
          sectionId: "warnings_and_cautions",
          quote:
            "Systemic eosinophilia, sometimes presenting with clinical features of vasculitis consistent with Churg-Strauss syndrome, has been reported.",
        },
        {
          sectionId: "warnings_and_cautions",
          quote:
            "In many cases, symptoms resolved after stopping SINGULAIR therapy; however, in some cases symptoms persisted after discontinuation of",
        },
      ],
    },

    {
      id: "contraindications-interactions",
      title: "Who should not take it, and drug interactions",
      emphasis: "normal",
      plain: [
        "The label lists one contraindication: hypersensitivity to any component of the medication.",
        "For drug interactions, the label states that no dose adjustment is needed when it is taken with a list of common medications including theophylline, prednisone, oral contraceptives, digoxin, warfarin, and others.",
        "This does not mean no interaction is possible with any medication. Your pharmacist can check your specific medication list.",
      ],
      citations: [
        {
          sectionId: "contraindications",
          quote:
            "SINGULAIR is contraindicated in patients with hypersensitivity to any of its components.",
        },
        {
          sectionId: "drug_interactions",
          quote:
            "No dose adjustment is needed when SINGULAIR is co-administered with theophylline, prednisone, prednisolone, oral contraceptives, fexofenadine, digoxin, warfarin, gemfibrozil, itraconazole, thyroid hormones, sedative hypnotics, non-steroidal anti-inflammatory agents, benzodiazepines, decongestants, and Cytochrome P450 (CYP) enzyme inducers",
        },
      ],
    },

    {
      id: "special-populations",
      title: "Pregnancy, children, and older adults",
      emphasis: "normal",
      plain: [
        "Pregnancy: the label states that available data from published studies over decades have not established a drug-associated risk of major birth defects. It also notes that all pregnancies carry a background risk, and that poorly controlled asthma carries its own risks.",
        "Children: safety and effectiveness for asthma have been established in children 6 to 14 years of age, with safety and efficacy data similar to adults. Children in that age range use a different strength than the 10 mg tablet.",
        "Older adults: the label states no dosage adjustment in the elderly is required, while noting that greater sensitivity in some older individuals cannot be ruled out.",
      ],
      citations: [
        {
          sectionId: "pregnancy",
          quote:
            "Available data from published prospective and retrospective cohort studies over decades with montelukast use in pregnant women have not established a drug-associated risk of major birth defects",
        },
        {
          sectionId: "pregnancy",
          quote:
            "All pregnancies have a background risk of birth defect, loss, or other adverse outcomes.",
        },
        {
          sectionId: "pediatric_use",
          quote:
            "Safety and effectiveness of SINGULAIR for asthma have been established in pediatric patients 6 to 14 years of age.",
        },
        {
          sectionId: "geriatric_use",
          quote: "No dosage adjustment in the elderly is required.",
        },
        {
          sectionId: "geriatric_use",
          quote: "greater sensitivity of some older individuals cannot be ruled out",
        },
      ],
    },

    {
      id: "how-its-taken",
      title: "How it is taken (as described in the label)",
      emphasis: "normal",
      plain: [
        "For asthma, the label describes once-daily dosing in the evening, with or without food.",
        "For preventing exercise-induced breathing problems, the label describes one tablet at least 2 hours before exercise.",
        "People who have both asthma and allergic rhinitis are directed to take only one dose daily, in the evening.",
        "This is what the label says in general. It is not a dosing instruction for you — follow the directions on your own prescription and ask your prescriber or pharmacist about your situation.",
      ],
      detail: [
        "Which product a person takes depends on age, and the label maps them explicitly: 15 years and older take one 10 mg tablet — the product this page describes. People aged 6 to 14 take one 5 mg chewable tablet. Ages 2 to 5 take one 4 mg chewable tablet or a packet of 4 mg oral granules. Ages 6 to 23 months take a packet of 4 mg oral granules.",
        "This matters because the strengths are not interchangeable. A 10 mg tablet is not a child's dose, and the chewable tablets and granules are separate products with their own packaging and instructions.",
      ],
      citations: [
        {
          sectionId: "dosage_and_administration",
          quote:
            "For asthma, administer SINGULAIR orally once daily in the evening, with or without food.",
        },
        {
          sectionId: "dosage_and_administration",
          quote:
            "One tablet at least 2 hours before exercise for patients 6 years of age and older",
        },
        {
          sectionId: "dosage_and_administration",
          quote:
            "Patients with both asthma and allergic rhinitis should take only one dose daily in the evening",
        },
        {
          sectionId: "dosage_and_administration",
          quote: "15 years and older: one 10-mg tablet",
        },
        {
          sectionId: "dosage_and_administration",
          quote: "6 to 14 years: one 5-mg chewable tablet",
        },
        {
          sectionId: "dosage_and_administration",
          quote:
            "2 to 5 years: one 4-mg chewable tablet or one packet of 4-mg oral granules",
        },
        {
          sectionId: "dosage_and_administration",
          quote: "6 to 23 months: one packet of 4-mg oral granules",
        },
      ],
    },

    {
      id: "reporting",
      title: "Reporting a side effect",
      emphasis: "normal",
      plain: [
        "The label directs suspected adverse reactions to be reported to the manufacturer at 1-844-674-3200, or to the FDA at 1-800-FDA-1088 or www.fda.gov/medwatch.",
        "Reporting side effects is how safety signals like the boxed warning on this medication get identified in the first place.",
      ],
      citations: [
        {
          sectionId: "adverse_reactions",
          quote:
            "To report SUSPECTED ADVERSE REACTIONS, contact Organon LLC, a subsidiary of Organon & Co., Inc., at 1-844-674-3200 or FDA at 1-800-FDA-1088 or www.fda.gov/medwatch.",
        },
      ],
    },
  ],
};
