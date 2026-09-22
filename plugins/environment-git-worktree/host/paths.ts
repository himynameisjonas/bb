import {
  resolveCheckoutAttemptRoot,
  resolveCheckoutChildPath,
  resolveCheckoutTargetPath,
  resolveCheckoutsRoot,
} from "bb-environment-provider-host/checkout-paths";

export { deriveRepoDirName } from "bb-environment-provider-host/checkout-paths";

const WORKTREES_ROOT_DIR_NAME = "worktrees";

function worktreesRoot(dataDir: string) {
  return { dataDir, rootDirName: WORKTREES_ROOT_DIR_NAME };
}

export function resolveWorktreesRoot(dataDir: string): string {
  return resolveCheckoutsRoot(worktreesRoot(dataDir));
}

export function resolveWorktreeAttemptRoot(args: {
  dataDir: string;
  pathKey: string;
}): string {
  return resolveCheckoutAttemptRoot(worktreesRoot(args.dataDir), args.pathKey);
}

export function resolveWorktreeTargetPath(args: {
  dataDir: string;
  pathKey: string;
  sourcePath: string;
}): string {
  return resolveCheckoutTargetPath(worktreesRoot(args.dataDir), {
    pathKey: args.pathKey,
    sourcePath: args.sourcePath,
  });
}

export function resolveWorktreeChildPath(args: {
  dataDir: string;
  pathKey: string;
  childName: string;
}): string {
  return resolveCheckoutChildPath(worktreesRoot(args.dataDir), {
    pathKey: args.pathKey,
    childName: args.childName,
  });
}
