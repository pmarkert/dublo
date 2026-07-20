import { z } from "zod";

export const ScreenshotModeSchema = z.enum(["none", "viewport", "fullpage"]);

export const ReportGeneratorSchema = z.enum(["markdown", "html"]);

export const LlmProviderSchema = z.enum(["bedrock", "openai-compatible"]);

export const LlmProfileSchema = z
  .object({
    provider: LlmProviderSchema,
    modelId: z.string().trim().min(1),
    region: z.string().trim().min(1).optional(),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().min(1).optional(),
    inputPrice: z.number().nonnegative().optional(),
    outputPrice: z.number().nonnegative().optional(),
    cacheReadPrice: z.number().nonnegative().optional(),
    cacheWritePrice: z.number().nonnegative().optional(),
    currency: z.string().trim().min(1).optional(),
    tokenUnit: z.number().positive().optional()
  })
  .strict();

export const WorkspaceDefaultsSchema = z
  .object({
    baseUrl: z.string().url().optional(),
    llm: z.string().trim().min(1).optional(),
    persona: z.string().trim().min(1).optional(),
    context: z.array(z.string().trim().min(1)).optional(),
    maxSteps: z.number().int().positive().optional(),
    headless: z.boolean().optional(),
    screenshots: ScreenshotModeSchema.optional(),
    reports: z.array(ReportGeneratorSchema).optional(),
    debug: z.boolean().optional(),
    outputDir: z.string().trim().min(1).optional(),
    observationConfigFile: z.string().trim().min(1).optional()
  })
  .strict();

export const WorkspaceDefaultsPatchSchema = WorkspaceDefaultsSchema.partial();

export type LlmProfile = z.infer<typeof LlmProfileSchema>;
export type ReportGenerator = z.infer<typeof ReportGeneratorSchema>;
export type ScreenshotMode = z.infer<typeof ScreenshotModeSchema>;
export type WorkspaceDefaults = z.infer<typeof WorkspaceDefaultsSchema>;
export type WorkspaceDefaultsPatch = z.infer<typeof WorkspaceDefaultsPatchSchema>;