# Stage migration report (v2)

Generated 2026-10-28T06:25:19.772Z · mode: APPLIED

Records: 306 in, 306 out. IDs preserved. Original fields untouched. Problems: 0.

## Records per stage
| Stage | Records |
|---|---|
| Stage 0 – Company & Project Applicability Setup | 0 |
| Stage 1 – Land & Legal Due Diligence | 4 |
| Stage 2 – Planning & Development Approvals | 8 |
| Stage 3 – Statutory NOCs & Infrastructure Permissions | 11 |
| Stage 4 – IOD, Sanctions & Commencement | 13 |
| Stage 5 – Pre-Construction & Construction Compliance | 34 |
| Stage 6 – Environmental & Operational Permissions | 31 |
| Stage 7 – Completion, Occupancy & Handover | 13 |
| Stage 8 – RERA & Ongoing Obligations | 192 |
| Unmapped to Stage | 0 |

## Placement confidence
| Confidence | Records |
|---|---|
| high | 229 |
| low | 10 |
| medium | 67 |

## Compliance level
| Level | Records |
|---|---|
| Activity Level | 21 |
| Building Level | 18 |
| Company Level | 152 |
| Employee / Contractor Level | 4 |
| Phase Level | 18 |
| Project Level | 88 |
| Site Level | 5 |

## Default applicability
| Value | Records |
|---|---|
| Applicable | 240 |
| Conditional | 66 |

## Deadline rule (no dates were invented; recurring/event/one-time items are marked "pending validation")
| Type / status | Records |
|---|---|
| continuous / not_applicable | 34 |
| event / pending_validation | 121 |
| fixed / from_master | 7 |
| one_time / pending_validation | 56 |
| recurring / pending_validation | 40 |
| rule / from_master | 16 |
| unknown / pending_validation | 32 |

## Records whose stage changed from the old framework (24)
- SAN-003: S2 -> S3 (Defence (MOD) NOC)
- SAN-005: S2 -> S3 (Fire NOC)
- SAN-020: S5 -> S4 (Sanction of FSI against in-situ road and amenity (an FSI sanction))
- SAN-029: S8 -> S4 (RERA registration and its registration-time requirements are needed before marketing or sale, so they sit with sanctions/commencement, not in the ongoing stage)
- SAN-030: S8 -> S4 (RERA registration and its registration-time requirements are needed before marketing or sale, so they sit with sanctions/commencement, not in the ongoing stage)
- SAN-031: S8 -> S4 (RERA registration and its registration-time requirements are needed before marketing or sale, so they sit with sanctions/commencement, not in the ongoing stage)
- SAN-032: S8 -> S4 (RERA registration and its registration-time requirements are needed before marketing or sale, so they sit with sanctions/commencement, not in the ongoing stage)
- SAN-033: S8 -> S4 (RERA registration and its registration-time requirements are needed before marketing or sale, so they sit with sanctions/commencement, not in the ongoing stage)
- SAN-042: S8 -> S5 (Development must follow sanctioned plans during construction)
- SAN-047: S8 -> S7 (Completion certificate and occupancy certificate)
- SAN-048: S8 -> S7 (Completion certificate and occupancy certificate)
- SAN-049: S8 -> S7 (Association/society formation, common-area possession, conveyance and document handover)
- SAN-050: S8 -> S7 (Association/society formation, common-area possession, conveyance and document handover)
- SAN-051: S8 -> S7 (Association/society formation, common-area possession, conveyance and document handover)
- SAN-052: S8 -> S7 (Association/society formation, common-area possession, conveyance and document handover)
- SAN-062: S8 -> S2 (Development permission requirements and penalties for development without permission)
- SAN-063: S8 -> S2 (Development permission requirements and penalties for development without permission)
- SAN-064: S8 -> S2 (Development permission requirements and penalties for development without permission)
- SAN-065: S8 -> S2 (Development permission requirements and penalties for development without permission)
- SAN-066: S8 -> S2 (Development permission requirements and penalties for development without permission)
- SAN-067: S8 -> S1 (Zoning, undeveloped-area and reserved-land restrictions)
- SAN-068: S8 -> S1 (Zoning, undeveloped-area and reserved-land restrictions)
- SAN-069: S8 -> S2 (Development must follow a sanctioned Town Planning Scheme)
- SAN-070: S8 -> S1 (Land acquisition for public purpose (land-rights law))

## Low-confidence placements for legal review (10)
- ADM-001 -> S8: Fire protection and life safety upkeep; confirm whether it is a construction or an operating duty
- HEA-019 -> S5: Noise standards and zoning (largely the State's duty); construction noise context
- HEA-020 -> S5: Noise standards and zoning (largely the State's duty); construction noise context
- SAN-004 -> S2: Source entry is only "Architecture Team"; treated as a design/planning input
- SAN-017 -> S4: Royalty order (State Govt): timing is not stated in the source
- SAN-027 -> S7: IOC to Sales and Sales Annexures: handover-to-sales step; meaning of "IOC" to be confirmed
- SAN-028 -> S7: IOC to Sales and Sales Annexures: handover-to-sales step; meaning of "IOC" to be confirmed
- SAN-056 -> S8: Applies to real estate agents rather than the promoter; confirm applicability
- SAN-061 -> S8: Applies to real estate agents (registration renewal); confirm applicability
- SAN-070 -> S1: Land acquisition for public purpose (land-rights law)

## Possible duplicates (kept as separate records, linked by group)
- **RERA registration before marketing**: SAN-029, MAR-001, LEG-001
- **Consent to Establish (CTE)**: SAN-023, EC-003, EC-007
- **Consent to Operate (CTO)**: SAN-024, EC-004
- **70% separate (escrow) account**: SAN-033, FIN-012
- **Structural defect liability (5 years)**: SAN-044, LEG-006
- **Association / society formation**: SAN-049, LEG-008
- **Conveyance / transfer of ownership**: SAN-051, LEG-009
- **Completion certificate**: SAN-047, LEG-005
- **Occupancy certificate**: SAN-026, SAN-048
- **RERA number in advertisements**: SAN-039, MAR-002
- **Ten percent advance limit**: SAN-041, MAR-006
- **Project website updates**: SAN-037, SAN-038, MAR-007, LEG-003
- **Annual RERA audit**: SAN-036, FIN-002
- **Internal Complaints Committee**: LAB-039, SEC-026
- **ICC annual report**: LAB-040, SEC-027

## Existing admin stage overrides in MongoDB (1, left untouched)
- SAN-001: S1
