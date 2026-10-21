import { Worker } from 'node:worker_threads';
import { z } from 'zod';

export const regexPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (pattern) => {
      try {
        new RegExp(`^(?:${pattern})$`);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Allowed patterns must be valid regular expressions.' }
  );

export async function matchFullRegex(
  patterns: string[],
  value: string,
  label: string
): Promise<string | undefined> {
  const index = await new Promise<number>((resolve, reject) => {
    const worker = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads');
        const index = workerData.patterns.findIndex((pattern) => {
          const match = new RegExp('^(?:' + pattern + ')$').exec(workerData.value);
          return match !== null && match[0] === workerData.value;
        });
        parentPort.postMessage(index);
      `,
      { eval: true, workerData: { patterns, value } }
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(
        new Error(
          `${label} regex matching exceeded the two-second limit. Simplify the configured patterns.`
        )
      );
    }, 2000);

    worker.once('message', (matchedIndex: number) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(matchedIndex);
    });
    worker.once('error', () => {
      clearTimeout(timer);
      void worker.terminate();
      reject(
        new Error(
          `Unable to evaluate ${label.toLowerCase()} regular expressions.`
        )
      );
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      reject(
        new Error(
          `${label} regex evaluation stopped before producing a result.`
        )
      );
    });
  });

  return index < 0 ? undefined : patterns[index];
}
