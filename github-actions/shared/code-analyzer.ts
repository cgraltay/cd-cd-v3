import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);

export const codeAnalyzerPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    packageDirectories: z.array(nonEmptyString).min(1).default(['force-app']),
    configPath: nonEmptyString.default('code-analyzer.yml'),
    ruleSelectors: z.array(nonEmptyString).min(1).default(['Recommended']),
    failOnSeverity: z.number().int().min(1).max(5).default(5),
    maxInlineComments: z.number().int().min(0).max(100).default(50)
  })
  .passthrough();
