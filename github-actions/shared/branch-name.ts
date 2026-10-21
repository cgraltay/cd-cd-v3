import { z } from 'zod';
import { regexPatternSchema } from './regex';

export const branchNamePolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    allowedSourcePatterns: z.array(regexPatternSchema).max(256).default([])
  })
  .passthrough()
  .superRefine((policy, context) => {
    if (policy.enabled && policy.allowedSourcePatterns.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Enabled branch name checks need allowed source patterns.'
      });
    }
  });
