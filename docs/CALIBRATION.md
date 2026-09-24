# Calibration

Demography must be stable before any emergent result counts (§0.8). `npm run calibrate` runs N seeds × Y years on a worker pool and reports against the §15 M1 targets. Per-seed values are tabulated. Modal age at death and interbirth interval are **pooled** across seeds, because a per-seed mode is fragile: famine years can give a single seed a second, young-adult peak.

Tools: `npm run calibrate`, `npm run sweep` (population trajectory for one config), `npm run compare` (several config variants × seeds).

## M1 result (code m1.0, 20 seeds × 300 years)

Full report: [`calibration-m1-report.md`](calibration-m1-report.md).

| target | value | status |
|---|---|---|
| population neither extinct nor > 4× start in ≥ 80% of seeds | 20/20 | PASS |
| total fertility 4–6 births per woman (completed fertility, women reaching 45) | 5.50 | PASS |
| 40–60% of births survive to 15 | 50.1% | PASS |
| modal adult age at death 60–75 (pooled; per-seed median 57) | 60 | PASS |
| mean interbirth interval 3–4 years (pooled) | 4.05 | FAIL (marginal) |

Deaths by cause: starvation 43%, old age and illness 33%, infant illness 15%, epidemic 5%, hunting accident 3%, childbirth and unattended-child accidents under 1% each.

### Open issues (flagged, not hidden)

1. **Interbirth interval 4.05 years, just above the 3–4 target.** The median interval is below 4. The mean is pulled up by long gaps during famine years, when body condition suppresses conception. That is the intended mechanism, but its tail is long. Levers that shorten it (lower condition thresholds, higher fecundity) raise completed fertility, which increases famine mortality and pushes the modal age at death younger. This is a real trade-off in the model, not a tuning oversight.
2. **Starvation is the leading cause of death.** Real forager populations die mostly of infectious disease. In this model, density dependence runs mainly through food, and epidemics only partly (their spread scales with camp density). Making epidemics carry more of the regulation destabilized the modal age (variant "D4e"), so it was rejected for M1.
3. **Bimodal seeds.** 6 of 20 seeds have a per-seed modal adult age of about 17–20, from famine episodes that kill newly independent young adults. The pooled mode is 60.

These will be re-checked after M2 and M3. Sharing, group hunting and conflict all change food flow and mortality, so demography is recalibrated at those milestones.

## What was tuned in M1, and why

Each change targets a mechanism found by tracing individual agents (scratch scripts that follow a victim's last days) rather than by fitting outputs directly.

| change | from → to | reason |
|---|---|---|
| plant regrowth / seeding / units per capacity | 0.05/0.004/7 → 0.15/0.02/10 | Harvested tiles recovered too slowly: each camp could sustain only ~25 people. |
| forage rate per step | 0.42 → 0.8 | Real foragers produce well above their own need; at 0.42 adults could barely feed themselves. |
| walking speed (cost/step) | 3.2 → 4 | Leaves time to work within a day trip. |
| season amplitude | 0.85 → 0.35 | Winter famine killed 65% in the first year. |
| drought effect | 1.1 → 0.6 | Drought-driven starvation dominated. |
| energy reserves | 12 → 20 food-days | Adults survived short lean spells too poorly compared with humans. |
| starvation health loss | 0.06 → 0.02/day, scaled ÷√size | Adults should outlast children in famines. |
| fecundity driver | daily energy → 90-day body condition, thresholds 0.83–0.97 | Fertility had no graded signal: people were either fed to target or starving, so growth continued until famine. |
| eating target | 0.85 → 0.97 | Needed so condition separates abundance from scarcity. |
| baseline conception | 0.011 → 0.02/day | Gated by condition, so the effective rate is much lower. |
| fertility decline start | 35 → 30 | Shorter fertile span keeps the population at better condition, with shorter intervals and less famine. |
| weaning | 2.5 → 2.0 years | Interbirth interval. |
| child provisioning weight | 2 → 1 × r × (1 + kinWeight) | Parents starved alongside their children. |
| adult kin provisioning | none → 0.6 × r × (1 + kinWeight) | New independents and old parents got nothing from kin. |
| Makeham / Gompertz A / B | 0.009/0.00045/0.084 → 0.004/0.00012/0.1 | Starvation, epidemics and accidents are modelled separately on top of the baseline. |
| infant term a1 | 0.14 → 0.18 | Survival to 15 was slightly high. |
| epidemic lethality | 0.004 → 0.002/day | ~12% case fatality was too high. |
| pairing rate / max age gap | 0.03 → 0.1 / 15 → 20 years | Widows re-pair faster. |

Bugs found through calibration (see DECISIONS.md): an unreachable-destination trap, a rest trap, effort utilities in mismatched units, followers paying walking costs at camp, and fordable rivers vs. the placement test.
