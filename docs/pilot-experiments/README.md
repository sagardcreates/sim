# Scarcity vs violence

Does lower carrying capacity or more frequent drought raise violence? (Violence must arise through contested food, not be written as a function of hunger.)

code m6.1 · 5 seeds × 100 years per variant · wall 1841s

| metric | rich | baseline | poor | droughty | poor+droughty |
|---|---|---|---|---|---|
| killingsPer1000PersonYears | 0.526 ± 0.246 | 0.516 ± 0.404 | 0.413 ± 0.261 | 1.302 ± 0.978 | 1.633 ± 0.783 |
| attacks | 86.8 ± 68.3 | 70.2 ± 56.5 | 61.6 ± 18.2 | 128 ± 79.7 | 138 ± 44.5 |
| threats | 407 ± 171 | 550 ± 271 | 736 ± 304 | 915 ± 218 | 1208 ± 143 |
| thefts | 87.4 ± 63.9 | 15.0 ± 11.4 | 1.800 ± 2.093 | 22.6 ± 28.3 | 2.400 ± 2.018 |
| feuds | 1.200 ± 1.143 | 0.400 ± 0.480 | 0.600 ± 0.480 | 1.400 ± 1.818 | 2.400 ± 1.329 |
| famines | 0.400 ± 0.480 | 0.800 ± 1.143 | 1.000 ± 1.074 | 1.000 ± 0.877 | 0.800 ± 1.143 |
| finalPopulation | 287 ± 81.6 | 224 ± 68.8 | 140 ± 40.2 | 199 ± 61.9 | 156 ± 32.8 |
| completedFertility | 4.356 ± 0.165 | 4.351 ± 0.581 | 3.897 ± 0.227 | 4.589 ± 0.336 | 4.297 ± 0.577 |
| survivalTo15 | 0.555 ± 0.018 | 0.550 ± 0.021 | 0.533 ± 0.027 | 0.538 ± 0.035 | 0.534 ± 0.020 |
| violentDeathShare | 0.016 ± 0.008 | 0.015 ± 0.012 | 0.012 ± 0.007 | 0.038 ± 0.029 | 0.046 ± 0.024 |

Per-run data: `runs/experiments/01-scarcity-violence/runs.csv`. Values are mean ± 95% CI over seeds.

---

# Food variance vs sharing norm

Does a more variable food supply (more hunting, less plant food, at similar mean) select for stronger sharing norms?

code m6.1 · 5 seeds × 100 years per variant · wall 1000s

| metric | low-variance (plants) | baseline | high-variance (game) |
|---|---|---|---|
| meanSharingNorm | 0.454 ± 0.056 | 0.450 ± 0.105 | 0.412 ± 0.136 |
| storeShare | 0.009 ± 0.004 | 0.004 ± 0.002 | 0.003 ± 0.002 |
| freeRiding |  ±  |  ±  |  ±  |
| meanOutgroupTrust | 0.423 ± 0.129 | 0.449 ± 0.128 | 0.403 ± 0.163 |
| finalPopulation | 226 ± 47.9 | 224 ± 68.8 | 162 ± 59.6 |
| completedFertility | 5.291 ± 0.581 | 4.351 ± 0.581 | 3.832 ± 0.485 |
| survivalTo15 | 0.486 ± 0.014 | 0.550 ± 0.021 | 0.538 ± 0.025 |
| violentDeathShare | 0.064 ± 0.041 | 0.015 ± 0.012 | 0.002 ± 0.002 |

Per-run data: `runs/experiments/02-variance-sharing/runs.csv`. Values are mean ± 95% CI over seeds.

---

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

---

# Isolation vs cultural divergence

Does a mountain barrier increase between-clan divergence in markers and functional traits?

code m6.1 · 5 seeds × 100 years per variant · wall 926s

| metric | open map | mountain barrier | barrier with 2 passes |
|---|---|---|---|
| cultureFstEnd | 0.961 ± 0.023 | 0.980 ± 0.008 | 0.969 ± 0.024 |
| cultureFstMean | 0.967 ± 0.009 | 0.979 ± 0.005 | 0.969 ± 0.014 |
| markerDivEnd | 0.922 ± 0.071 | 0.969 ± 0.061 | 0.977 ± 0.045 |
| markerDivMean | 0.964 ± 0.030 | 0.985 ± 0.029 | 0.992 ± 0.016 |
| meanCrossClanAffinity | 0.009 ± 0.008 | 0.006 ± 0.011 | -0.003 ± 0.006 |
| finalPopulation | 224 ± 68.8 | 174 ± 44.5 | 178 ± 47.1 |
| completedFertility | 4.351 ± 0.581 | 4.141 ± 0.722 | 4.056 ± 0.821 |
| survivalTo15 | 0.550 ± 0.021 | 0.534 ± 0.020 | 0.545 ± 0.022 |
| violentDeathShare | 0.015 ± 0.012 | 0.018 ± 0.011 | 0.026 ± 0.014 |

Per-run data: `runs/experiments/04-isolation-divergence/runs.csv`. Values are mean ± 95% CI over seeds.

---

# Residence rule vs cross-clan affinity and killings

Do marriage residence rules change how clans feel about each other and how often they kill each other?

code m6.1 · 5 seeds × 100 years per variant · wall 1032s

| metric | men move (matrilocal) | women move (patrilocal) | either |
|---|---|---|---|
| meanCrossClanAffinity | 0.013 ± 0.013 | 0.005 ± 0.006 | 0.000 ± 0.000 |
| killingsPer1000PersonYears | 0.750 ± 0.722 | 0.829 ± 1.126 | 0.794 ± 0.861 |
| alliances | 1.400 ± 1.818 | 0.400 ± 0.480 | 0.600 ± 0.784 |
| feuds | 1.000 ± 0.877 | 1.200 ± 1.568 | 1.000 ± 1.518 |
| finalPopulation | 248 ± 86.8 | 211 ± 80.4 | 207 ± 62.9 |
| completedFertility | 4.372 ± 0.594 | 3.996 ± 0.330 | 4.334 ± 0.589 |
| survivalTo15 | 0.545 ± 0.024 | 0.534 ± 0.018 | 0.533 ± 0.006 |
| violentDeathShare | 0.021 ± 0.019 | 0.023 ± 0.029 | 0.023 ± 0.025 |

Per-run data: `runs/experiments/05-residence/runs.csv`. Values are mean ± 95% CI over seeds.

---

# Revenge scope vs feud length and extinctions

Does widening who counts as a revenge target (killer only / kin / clan) lengthen feuds and cause clan extinctions?

code m6.1 · 5 seeds × 100 years per variant · wall 980s

| metric | killer only | killer's kin | killer's clan |
|---|---|---|---|
| feuds | 1.000 ± 1.074 | 0.400 ± 0.480 | 0.600 ± 0.480 |
| feudMeanYears | 8.667 ± 7.380 | 4.400 ± 5.317 | 5.000 ± 4.638 |
| killingsPer1000PersonYears | 0.693 ± 0.556 | 0.266 ± 0.254 | 0.400 ± 0.189 |
| extinctions | 0.600 ± 0.784 | 0.400 ± 0.480 | 0.400 ± 0.480 |
| finalPopulation | 197 ± 64.3 | 226 ± 49.2 | 190 ± 64.0 |
| completedFertility | 4.140 ± 0.378 | 4.475 ± 0.458 | 4.207 ± 0.250 |
| survivalTo15 | 0.541 ± 0.017 | 0.553 ± 0.015 | 0.531 ± 0.021 |
| violentDeathShare | 0.020 ± 0.017 | 0.008 ± 0.008 | 0.012 ± 0.006 |

Per-run data: `runs/experiments/06-revenge-scope/runs.csv`. Values are mean ± 95% CI over seeds.

---

# Emergent group-size attractors and fission rhythm

What clan sizes do groups settle around, how big are they when they split, and how often do splits recur?

code m6.1 · 5 seeds × 100 years per variant · wall 429s

| metric | baseline |
|---|---|
| meanClanSize | 48.9 ± 7.834 |
| fissionParentSizeMean | 42.4 ± 34.4 |
| fissionIntervalMean | 9.200 ± 18.0 |
| extinctions | 0.200 ± 0.392 |
| finalPopulation | 224 ± 68.8 |
| completedFertility | 4.351 ± 0.581 |
| survivalTo15 | 0.550 ± 0.021 |
| violentDeathShare | 0.015 ± 0.012 |

Per-run data: `runs/experiments/07-group-size/runs.csv`. Values are mean ± 95% CI over seeds.

---

# Kin vs clan loyalty when they conflict

When kin and clanmates pull different ways, how often do people move toward their kin, and does kin weight in loyalty matter?

code m6.1 · 5 seeds × 100 years per variant · wall 1062s

| metric | weak kin pull | baseline | strong kin pull |
|---|---|---|---|
| voluntaryMoves | 2.600 ± 1.592 | 4.200 ± 3.940 | 6.000 ± 5.647 |
| movesTowardKinShare | 0.900 ± 0.196 | 0.900 ± 0.196 | 0.850 ± 0.196 |
| fissionParentSizeMean | 42.4 ± 34.4 | 42.4 ± 34.4 | 42.4 ± 34.4 |
| finalPopulation | 228 ± 72.9 | 224 ± 68.8 | 218 ± 67.0 |
| completedFertility | 4.339 ± 0.565 | 4.351 ± 0.581 | 4.371 ± 0.726 |
| survivalTo15 | 0.544 ± 0.017 | 0.550 ± 0.021 | 0.542 ± 0.022 |
| violentDeathShare | 0.024 ± 0.027 | 0.015 ± 0.012 | 0.020 ± 0.020 |

Per-run data: `runs/experiments/08-kin-vs-clan/runs.csv`. Values are mean ± 95% CI over seeds.

---

# Marker innovation survival vs originator prestige

Do new body-paint patterns survive more often when their originator is high-status (prestige bias), even though markers are neutral?

code m6.1 · 5 seeds × 100 years per variant · wall 716s

| metric | baseline | no prestige bias |
|---|---|---|
| innovations | 551 ± 106 | 575 ± 103 |
| innovationSurvival | 0.015 ± 0.007 | 0.024 ± 0.009 |
| innovationStatusSurvivalCorr | 0.022 ± 0.050 | -0.022 ± 0.011 |
| finalPopulation | 210 ± 37.9 | 242 ± 62.8 |
| completedFertility | 4.551 ± 1.055 | 4.443 ± 0.358 |
| survivalTo15 | 0.529 ± 0.006 | 0.544 ± 0.017 |
| violentDeathShare | 0.010 ± 0.007 | 0.011 ± 0.011 |

Per-run data: `runs/experiments/09-marker-innovation/runs.csv`. Values are mean ± 95% CI over seeds.

---

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
