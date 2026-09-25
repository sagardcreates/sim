# Pilot experiments

These are **pilots**: 5 seeds × 100 years per variant (code m6.1, before play mode; research behaviour is unchanged since).
The full designs call for 50 seeds × 300 years (200 seeds for experiment 10).
Confidence intervals here are wide, so treat any effect as a lead, not a result.
Rerun at full size with `npm run batch -- --experiment configs/experiments/<file>.json`.

One pilot lead worth following up: drought, not low carrying capacity, raises violence.
Killings per 1,000 person-years:

| variant | killings per 1,000 person-years |
|---|---|
| baseline | 0.52 |
| poor | 0.41 |
| droughty | 1.30 |
| poor + droughty | 1.63 |

Violence arises through contested food under variable scarcity, never from a hunger→violence rule.
