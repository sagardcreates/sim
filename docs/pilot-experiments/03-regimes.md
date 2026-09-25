# Regime emergence from random legitimacy weights (+ lineage knockout)

Which regimes emerge from randomly seeded legitimacy weights, and does removing lineage as a source of legitimacy remove hereditary rule?

code m6.1 · 5 seeds × 100 years per variant · wall 740s

| metric | random weights | lineage knockout |
|---|---|---|
| regimeEgalitarian | 1.800 ± 1.300 | 2.400 ± 0.999 |
| regimeBigMan | 0.400 ± 0.784 | 1.000 ± 0.620 |
| regimeChiefly | 1.800 ± 0.960 | 1.000 ± 0.000 |
| regimeHereditary | 0.600 ± 0.784 | 0.200 ± 0.392 |
| regimeContested | 0.200 ± 0.392 | 0.000 ± 0.000 |
| kinSuccessionShare | 0.253 ± 0.200 | 0.077 ± 0.046 |
| tenureMean | 8.153 ± 1.843 | 8.761 ± 2.199 |
| leaderYearsShare | 0.548 ± 0.184 | 0.457 ± 0.160 |
| finalPopulation | 224 ± 68.8 | 234 ± 72.2 |
| completedFertility | 4.351 ± 0.581 | 4.229 ± 0.658 |
| survivalTo15 | 0.550 ± 0.021 | 0.550 ± 0.020 |
| violentDeathShare | 0.015 ± 0.012 | 0.029 ± 0.025 |

Per-run data: `runs/experiments/03-regimes/runs.csv`. Values are mean ± 95% CI over seeds.
