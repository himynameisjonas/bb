import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { readdir, rm } from "node:fs/promises";
import {
  resolveCheckoutAttemptRoot,
  resolveCheckoutChildPath,
  resolveCheckoutTargetPath,
} from "bb-environment-provider-host/checkout-paths";
import { readDefaultBranch } from "bb-environment-provider-host/git";
import {
  detectColocatedJjSource,
  runJj,
} from "bb-environment-provider-host/jj";
import { createHostProgress } from "bb-environment-provider-host/progress";
import { jjWorkspaceHostContract, jjWorkspaceHostSignals } from "./contract.js";
import { createJjWorkspace, removeJjWorkspace } from "./host/jj-workspace.js";

const WORKSPACES_ROOT_DIR_NAME = "workspaces";

function workspacesRoot(dataDir: string) {
  return { dataDir, rootDirName: WORKSPACES_ROOT_DIR_NAME };
}

function completionPathForWorkspace(workspacePath: string): string {
  return `${workspacePath}.completed`;
}

async function workspacePathsForPathKey(args: {
  dataDir: string;
  pathKey: string;
}): Promise<string[]> {
  const root = resolveCheckoutAttemptRoot(
    workspacesRoot(args.dataDir),
    args.pathKey,
  );
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        resolveCheckoutChildPath(workspacesRoot(args.dataDir), {
          pathKey: args.pathKey,
          childName: entry.name,
        }),
      );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function createJjWorkspaceHostEntry() {
  return experimental_defineHostEntry({
    contract: jjWorkspaceHostContract,
    experimental_signals: jjWorkspaceHostSignals,
    handlers: {
      async inspect(input) {
        const version = await runJj(["--version"], {
          cwd: input.sourcePath,
          allowFailure: true,
        });
        return {
          jjAvailable: version.exitCode === 0,
          colocatedJjSource: await detectColocatedJjSource(input.sourcePath),
        };
      },

      async create(input, context) {
        const targetPath = resolveCheckoutTargetPath(
          workspacesRoot(context.experimental_paths.dataDir),
          { pathKey: input.pathKey, sourcePath: input.sourcePath },
        );
        try {
          const baseBranch =
            input.baseBranch.kind === "named"
              ? input.baseBranch.name
              : ((await readDefaultBranch(input.sourcePath)) ?? null);
          const created = await createJjWorkspace({
            sourcePath: input.sourcePath,
            targetPath,
            completionPath: completionPathForWorkspace(targetPath),
            workspaceName: input.workspaceName,
            baseBranch,
            branchMode: input.branchMode,
            onProgress: createHostProgress({
              operationId: input.operationId,
              emit: (payload) =>
                context.experimental_emitSignal("progress", payload),
            }),
            signal: context.signal,
          });
          return {
            status: "created",
            path: created.path,
            baseBranch: input.baseBranch.kind === "named" ? baseBranch : null,
          } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          } as const;
        }
      },

      async remove(input, context) {
        try {
          const paths =
            input.path === null
              ? await workspacePathsForPathKey({
                  dataDir: context.experimental_paths.dataDir,
                  pathKey: input.pathKey,
                })
              : [input.path];
          for (const path of paths) {
            await rm(completionPathForWorkspace(path), { force: true });
            await removeJjWorkspace({
              path,
              onProgress: createHostProgress({
                operationId: input.operationId,
                emit: (payload) =>
                  context.experimental_emitSignal("progress", payload),
              }),
              signal: context.signal,
            });
          }
          return { status: "removed" } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          } as const;
        }
      },
    },
  });
}

export default createJjWorkspaceHostEntry();
