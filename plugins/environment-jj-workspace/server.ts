import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  PluginEnvironmentProviderCreateContext,
  PluginEnvironmentProviderCreateResult,
  PluginEnvironmentProviderProgress,
  PluginEnvironmentProviderRestoreContext,
} from "@get-bb/plugin-sdk/environment-provider";
import { reportHostProgress } from "bb-environment-provider-host/progress";
import { z } from "zod";
import {
  jjWorkspaceHostContract,
  jjWorkspaceHostSignals,
  workspaceBaseBranchSchema,
} from "./contract.js";
import { JJ_WORKSPACE_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

const INSPECT_TIMEOUT_MS = 30 * 1000;
const CREATE_TIMEOUT_MS = 15 * 60 * 1000;
const REMOVE_TIMEOUT_MS = 15 * 60 * 1000;

export const jjWorkspaceInputsSchema = z
  .object({
    branch: workspaceBaseBranchSchema.default({ kind: "default" }),
  })
  .default({ branch: { kind: "default" } });
export type JjWorkspaceInputs = z.infer<typeof jjWorkspaceInputsSchema>;

type CreateOrRestoreContext =
  | PluginEnvironmentProviderCreateContext<
      { gitCheckout: true },
      typeof jjWorkspaceInputsSchema
    >
  | PluginEnvironmentProviderRestoreContext<
      { gitCheckout: true },
      typeof jjWorkspaceInputsSchema
    >;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function jjWorkspacePlugin(bb: BbPluginApi): Promise<void> {
  const host = bb.hosts.experimental_client({
    contract: jjWorkspaceHostContract,
    experimental_signals: jjWorkspaceHostSignals,
  });
  const reports = new Map<string, PluginEnvironmentProviderProgress>();

  host.experimental_onSignal("progress", (event) => {
    const report = reports.get(event.payload.operationId);
    if (report !== undefined) reportHostProgress(report, event.payload);
  });

  async function createWorkspace(
    context: CreateOrRestoreContext,
    target: {
      workspaceName: string;
      branchMode: "reset" | "reuse-existing";
    },
  ): Promise<PluginEnvironmentProviderCreateResult> {
    const operationId = `create#${context.pathKey}#${context.attempt}`;
    reports.set(operationId, context.report);
    try {
      const result = await host.call(
        "create",
        {
          operationId,
          sourcePath: context.projectCheckout.path,
          pathKey: context.pathKey,
          workspaceName: target.workspaceName,
          baseBranch: context.inputs.branch,
          branchMode: target.branchMode,
        },
        {
          hostId: context.host.id,
          signal: context.signal,
          timeoutMs: CREATE_TIMEOUT_MS,
        },
      );
      if (result.status === "failed") {
        return { status: "failed", message: result.message };
      }
      return {
        status: "created",
        path: result.path,
        ownsPath: true,
        ...(result.baseBranch === null
          ? {}
          : { mergeBaseBranch: result.baseBranch }),
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return { status: "failed", message: errorMessage(error) };
    } finally {
      reports.delete(operationId);
    }
  }

  bb.experimental_environments.register({
    id: JJ_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
    displayName: "Workspace",
    description:
      "Create an isolated Jujutsu workspace of a colocated repository for your changes.",
    icon: "FolderSync",
    requires: { gitCheckout: true },
    inputs: jjWorkspaceInputsSchema,
    policy: { pathKeys: "per-attempt" },
    async availability(context) {
      if (context.projectCheckout === null) {
        return {
          status: "unavailable",
          message: "Needs a project checkout on this machine",
        };
      }
      try {
        const inspected = await host.call(
          "inspect",
          { sourcePath: context.projectCheckout.path },
          { hostId: context.host.id, timeoutMs: INSPECT_TIMEOUT_MS },
        );
        if (!inspected.jjAvailable) {
          return {
            status: "unavailable",
            message: "jj is not installed on this machine",
          };
        }
        if (!inspected.jjColocatesWorkspaces) {
          return {
            status: "setup-required",
            message: "Upgrade jj to 0.46 or newer on this machine",
          };
        }
        if (!inspected.colocatedJjSource) {
          return {
            status: "unavailable",
            message:
              "The project checkout is not a colocated Jujutsu repository",
          };
        }
        return { status: "available" };
      } catch (error) {
        return { status: "unavailable", message: errorMessage(error) };
      }
    },
    async create(context) {
      return createWorkspace(context, {
        workspaceName: context.suggestedBranchName,
        branchMode: "reset",
      });
    },
    async restore(context) {
      const workspaceName = context.previous.environment.branchName;
      if (workspaceName === null) {
        return {
          status: "failed",
          message:
            "The removed workspace had no bookmark, so there is nothing to restore it on.",
        };
      }
      return createWorkspace(context, {
        workspaceName,
        branchMode: "reuse-existing",
      });
    },
    async remove(context) {
      if (context.hostId === null) {
        return {
          status: "failed",
          message: "The workspace machine is unknown",
        };
      }
      const operationId = `remove#${context.pathKey}#${context.attempt}`;
      reports.set(operationId, context.report);
      try {
        return await host.call(
          "remove",
          {
            operationId,
            pathKey: context.pathKey,
            path: context.path,
          },
          {
            hostId: context.hostId,
            signal: context.signal,
            timeoutMs: REMOVE_TIMEOUT_MS,
          },
        );
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: errorMessage(error) };
      } finally {
        reports.delete(operationId);
      }
    },
  });
}
