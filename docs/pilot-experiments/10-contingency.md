# Contingency

With one configuration and many seeds, which outcomes are robust and which are accidents of history?

code m6.1 · 5 seeds × 100 years per variant · wall 428s

| metric | baseline |
|---|---|
| killingsPer1000PersonYears | 0.516 ± 0.404 |
| meanClanSize | 48.9 ± 7.834 |
| extinctions | 0.200 ± 0.392 |
| alliances | 0.800 ± 0.733 |
| feuds | 0.400 ± 0.480 |
| leaderYearsShare | 0.548 ± 0.184 |
| tenureMean | 8.153 ± 1.843 |
| cultureFstEnd | 0.961 ± 0.023 |
| markerDivEnd | 0.922 ± 0.071 |
| meanSharingNorm | 0.450 ± 0.105 |
| finalPopulation | 224 ± 68.8 |
| completedFertility | 4.351 ± 0.581 |
| survivalTo15 | 0.550 ± 0.021 |
| violentDeathShare | 0.015 ± 0.012 |

## Robustness across seeds

Coefficient of variation across seeds: low = robust outcome, high = contingent on history.

| metric | mean | sd | CV | min | max |
|---|---|---|---|---|---|
| killingsPer1000PersonYears | 0.516 | 0.461 | 0.893 | 0.042 | 1.204 |
| meanClanSize | 48.9 | 8.937 | 0.183 | 34.2 | 58.2 |
| extinctions | 0.200 | 0.447 | 2.236 | 0.000 | 1.000 |
| alliances | 0.800 | 0.837 | 1.046 | 0.000 | 2.000 |
| feuds | 0.400 | 0.548 | 1.369 | 0.000 | 1.000 |
| leaderYearsShare | 0.548 | 0.210 | 0.383 | 0.226 | 0.759 |
| tenureMean | 8.153 | 2.103 | 0.258 | 5.044 | 10.9 |
| cultureFstEnd | 0.961 | 0.026 | 0.027 | 0.916 | 0.979 |
| markerDivEnd | 0.922 | 0.082 | 0.088 | 0.805 | 1.000 |
| meanSharingNorm | 0.450 | 0.120 | 0.267 | 0.295 | 0.565 |
| finalPopulation | 224 | 78.5 | 0.351 | 121 | 302 |
| completedFertility | 4.351 | 0.663 | 0.152 | 3.539 | 5.069 |
| survivalTo15 | 0.550 | 0.024 | 0.044 | 0.515 | 0.571 |
| violentDeathShare | 0.015 | 0.014 | 0.918 | 0.001 | 0.037 |

Per-run data: `runs/experiments/10-contingency/runs.csv`. Values are mean ± 95% CI over seeds.
