/** Minimal worker_threads pool: runs RunJobs in parallel, results in job order. */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { RunJob, RunResult } from './jobs';

export async function runPool(jobs: RunJob[], opts: { threads?: number; onDone?: (r: RunResult, done: number) => void } = {}): Promise<RunResult[]> {
  const threads = Math.max(1, Math.min(opts.threads ?? availableParallelism(), jobs.length));
  const results: RunResult[] = new Array(jobs.length);
  let next = 0;
  let done = 0;
  // Bundle the worker entry to plain JS so threads don't depend on loader hooks.
  const dir = join(tmpdir(), 'terrarium-pool');
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, `pool-worker-${process.pid}.mjs`);
  await build({
    entryPoints: [fileURLToPath(new URL('./pool-worker.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error',
  });
  await Promise.all(Array.from({ length: threads }, () => new Promise<void>((resolve, reject) => {
    const w = new Worker(outfile);
    const feed = () => {
      if (next >= jobs.length) {
        void w.terminate();
        resolve();
        return;
      }
      const i = next++;
      w.once('message', (r: RunResult) => {
        results[i] = r;
        done++;
        opts.onDone?.(r, done);
        feed();
      });
      w.postMessage(jobs[i]);
    };
    w.on('error', reject);
    feed();
  })));
  return results;
}
