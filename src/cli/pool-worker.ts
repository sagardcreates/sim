import { parentPort } from 'node:worker_threads';
import { runJob, type RunJob } from './jobs';

parentPort!.on('message', (job: RunJob) => {
  parentPort!.postMessage(runJob(job));
});
