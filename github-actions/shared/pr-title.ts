import { z } from 'zod';
import { regexPatternSchema } from './regex';

export const prTitlePolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    allowedPatterns: z.array(regexPatternSchema).max(256).default([])
  })
  .passthrough()
  .superRefine((policy, context) => {
    if (policy.enabled && policy.allowedPatterns.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Enabled PR title checks need allowed title patterns.'
      });
    }
  });
