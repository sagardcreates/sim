import tseslint from 'typescript-eslint';

const simBannedGlobals = [
  'window', 'document', 'navigator', 'self', 'postMessage', 'performance',
  'requestAnimationFrame', 'setTimeout', 'setInterval', 'process', 'fetch',
].map((name) => ({ name, message: 'src/sim must stay pure: no DOM/host globals.' }));

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'runs'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...simBannedGlobals],
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['three', 'three/*'], message: 'Renderer imports are forbidden in src/sim.' },
          { group: ['**/render/**', '**/ui/**', '**/worker/**', '**/debug/**', '**/cli/**'], message: 'src/sim may not import from outer layers.' },
          { group: ['node:*', 'fs', 'path', 'os', 'worker_threads'], message: 'src/sim may not import Node modules.' },
        ],
      }],
      'no-restricted-properties': ['error',
        { object: 'Math', property: 'random', message: 'Use the seeded RNG (src/sim/rng.ts).' },
        { object: 'Date', property: 'now', message: 'Sim time is ticks, never wall clock.' },
      ],
      'no-restricted-syntax': ['error',
        { selector: "NewExpression[callee.name='Date']", message: 'No wall-clock time in the sim.' },
      ],
    },
  },
);
