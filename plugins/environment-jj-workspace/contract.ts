import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { environmentHostProgressSchema } from "bb-environment-provider-host/progress";

export const workspaceBaseBranchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("default") }).strict(),
]);
export type WorkspaceBaseBranch = z.infer<typeof workspaceBaseBranchSchema>;

const failedSchema = z
  .object({ status: z.literal("failed"), message: z.string().min(1) })
  .strict();

export const jjWorkspaceHostContract = defineRpcContract({
  inspect: {
    input: z.object({ sourcePath: z.string().min(1) }).strict(),
    output: z
      .object({
        jjAvailable: z.boolean(),
        colocatedJjSource: z.boolean(),
      })
      .strict(),
  },
  create: {
    input: z
      .object({
        operationId: z.string().min(1),
        sourcePath: z.string().min(1),
        pathKey: z.string().min(1),
        workspaceName: z.string().min(1),
        baseBranch: workspaceBaseBranchSchema,
        branchMode: z.enum(["reset", "reuse-existing"]),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("created"),
          path: z.string().min(1),
          baseBranch: z.string().min(1).nullable(),
        })
        .strict(),
      failedSchema,
    ]),
  },
  remove: {
    input: z
      .object({
        operationId: z.string().min(1),
        pathKey: z.string().min(1),
        path: z.string().min(1).nullable(),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("removed") }).strict(),
      failedSchema,
    ]),
  },
});

export const jjWorkspaceHostSignals = {
  progress: {
    payload: environmentHostProgressSchema,
  },
} as const;
