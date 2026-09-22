import { experimental_killProcessesWithCwdUnder } from "@get-bb/plugin-sdk/host";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getGitCommonDir,
  hasRef,
  readGitRepositoryState,
  runGit,
  WorkspaceError,
} from "bb-environment-provider-host/git";
import {
  attachShadowGitCheckout,
  detectColocatedJjSource,
  readJjWorkspaceName,
  resolveJjWorkspaceLayout,
  runJj,
} from "bb-environment-provider-host/jj";
import { withWorktreeMetadataLock } from "bb-environment-provider-host/locks";
import {
  emitCwd,
  emitOutput,
  emitStep,
  isProvisionAbortError,
  throwIfProvisionAborted,
  type ProgressCallback,
} from "bb-environment-provider-host/transcript";
import {
  copyWorktreeIncludeFiles,
  WORKTREE_INCLUDE_FILE_NAME,
} from "bb-environment-provider-host/worktree-include";

export type BranchMode = "reset" | "reuse-existing";

interface CreateJjWorkspaceArgs {
  sourcePath: string;
  targetPath: string;
  completionPath: string;
  workspaceName: string;
  baseBranch: string | null;
  branchMode: BranchMode;
  onProgress?: ProgressCallback | undefined;
  signal?: AbortSignal | undefined;
}

interface RemoveJjWorkspaceArgs {
  path: string;
  onProgress?: ProgressCallback | undefined;
  signal?: AbortSignal | undefined;
}

const INCLUDE_TRANSCRIPT_PATH_LIMIT = 20;

function signalOptions(signal: AbortSignal | undefined) {
  return signal !== undefined ? { signal } : {};
}

interface JjBase {
  revset: string;
  remote: { name: string; branch: string } | null;
}

/**
 * Rewrites a base branch as something jj can resolve.
 *
 * Bases arrive in git's spelling, where a remote-tracking branch is
 * `origin/main`. jj has no such ref: the same commit is the remote bookmark
 * `main@origin`. Local branches are spelled the same in both, so they pass
 * through, including ones whose name contains a slash.
 */
async function resolveJjBase(
  sourcePath: string,
  baseBranch: string,
  signal: AbortSignal | undefined,
): Promise<JjBase> {
  if (!baseBranch.includes("/")) {
    return { revset: baseBranch, remote: null };
  }
  const remotes = (
    await runGit(["remote"], { cwd: sourcePath, ...signalOptions(signal) })
  ).stdout
    .split("\n")
    .map((remote) => remote.trim())
    .filter(Boolean)
    .filter(
      (remote) =>
        baseBranch.startsWith(`${remote}/`) &&
        baseBranch.length > remote.length + 1,
    )
    .sort((left, right) => right.length - left.length);
  const remote = remotes[0];
  if (!remote) {
    return { revset: baseBranch, remote: null };
  }
  const branch = baseBranch.slice(remote.length + 1);
  return { revset: `${branch}@${remote}`, remote: { name: remote, branch } };
}

const REMOTE_BASE_FETCH_TIMEOUT_MS = 60_000;

async function fetchRemoteBase(args: {
  sourcePath: string;
  baseBranch: string;
  remote: { name: string; branch: string };
  onProgress: ProgressCallback | undefined;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const startedAt = Date.now();
  emitStep({
    onProgress: args.onProgress,
    key: "jj-fetch-started",
    text: `Fetching ${args.baseBranch}`,
    status: "started",
    startedAt,
  });
  try {
    await runJj(
      [
        "git",
        "fetch",
        "--remote",
        args.remote.name,
        "--branch",
        args.remote.branch,
      ],
      {
        cwd: args.sourcePath,
        timeoutMs: REMOTE_BASE_FETCH_TIMEOUT_MS,
        ...signalOptions(args.signal),
      },
    );
    emitStep({
      onProgress: args.onProgress,
      key: "jj-fetch-completed",
      text: `Fetched ${args.baseBranch}`,
      status: "completed",
      startedAt,
      metadata: { durationMs: Date.now() - startedAt },
    });
  } catch (error) {
    emitStep({
      onProgress: args.onProgress,
      key: "jj-fetch-failed",
      text: `Failed to fetch ${args.baseBranch}`,
      status: "failed",
      startedAt,
      metadata: { durationMs: Date.now() - startedAt },
    });
    throw error;
  }
}

async function existingWorkspaceMatches(
  targetPath: string,
  workspaceName: string,
): Promise<boolean> {
  const layout = await resolveJjWorkspaceLayout(targetPath);
  if (layout?.kind !== "secondary") {
    return false;
  }
  return (
    (await readJjWorkspaceName(layout.sourcePath, targetPath)) === workspaceName
  );
}

async function readCompletedWorkspace(
  completionPath: string,
): Promise<string | null> {
  try {
    return (await fs.readFile(completionPath, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

function summarizePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, INCLUDE_TRANSCRIPT_PATH_LIMIT);
  const hiddenCount = paths.length - shown.length;
  return `${shown.join(", ")}${hiddenCount > 0 ? `, and ${hiddenCount} more` : ""}`;
}

async function copyIncludedFiles(args: CreateJjWorkspaceArgs): Promise<void> {
  throwIfProvisionAborted(args.signal);
  const startedAt = Date.now();
  let result;
  try {
    result = await copyWorktreeIncludeFiles({
      sourcePath: args.sourcePath,
      targetPath: args.targetPath,
      signal: args.signal,
    });
  } catch (error) {
    if (isProvisionAbortError(error)) {
      throw error;
    }
    emitOutput(
      args.onProgress,
      "worktree-include",
      `Skipped ${WORKTREE_INCLUDE_FILE_NAME}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  if (!result.ran) {
    return;
  }
  for (const skipped of result.skipped.slice(0, INCLUDE_TRANSCRIPT_PATH_LIMIT)) {
    emitOutput(args.onProgress, "worktree-include", `Skipped ${skipped}`);
  }
  if (result.copied.length > 0) {
    emitOutput(
      args.onProgress,
      "worktree-include",
      `Copied ${result.copied.length} file(s): ${summarizePaths(result.copied)}`,
    );
  }
  emitStep({
    onProgress: args.onProgress,
    key: "worktree-include-completed",
    text: `Copied ${result.copied.length} file(s) from ${WORKTREE_INCLUDE_FILE_NAME}`,
    status: "completed",
    startedAt,
    metadata: { durationMs: Date.now() - startedAt },
  });
}

async function finishWorkspaceSetup(args: CreateJjWorkspaceArgs): Promise<void> {
  emitCwd({
    onProgress: args.onProgress,
    keySuffix: "target",
    cwd: args.targetPath,
  });
  await copyIncludedFiles(args);
  await fs.writeFile(args.completionPath, `${args.workspaceName}\n`, "utf8");
}

async function forgetJjWorkspace(
  sourcePath: string,
  workspaceName: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const commonDir = await getGitCommonDir(sourcePath);
  await withWorktreeMetadataLock(
    commonDir,
    () =>
      runJj(["workspace", "forget", workspaceName], {
        cwd: sourcePath,
        allowFailure: true,
        ...signalOptions(signal),
      }),
    signal,
  );
}

async function removeCreateTarget(args: CreateJjWorkspaceArgs): Promise<void> {
  await fs.rm(args.completionPath, { force: true });
  await removeJjWorkspace({ path: args.targetPath, ...signalOptions(args.signal) });
  await forgetJjWorkspace(args.sourcePath, args.workspaceName, args.signal);
}

/**
 * Creates the managed checkout as a real jj workspace, so the thread's work
 * is jj-native: it shows up in `jj log`, and jj's operation log can undo it.
 *
 * The workspace is named after the branch bb would otherwise have created,
 * and a bookmark of that name is set on the base so committed work has
 * somewhere to land. `attachShadowGitCheckout` then registers the workspace
 * as a git worktree, which is what lets every git-based read keep working.
 */
export async function createJjWorkspace(
  args: CreateJjWorkspaceArgs,
): Promise<{ path: string }> {
  throwIfProvisionAborted(args.signal);
  if (await existingWorkspaceMatches(args.targetPath, args.workspaceName)) {
    if (
      (await readCompletedWorkspace(args.completionPath)) === args.workspaceName
    ) {
      return { path: args.targetPath };
    }
    try {
      await finishWorkspaceSetup(args);
      return { path: args.targetPath };
    } catch (error) {
      await removeCreateTarget(args);
      throw error;
    }
  }

  await removeCreateTarget(args);

  throwIfProvisionAborted(args.signal);
  switch (await readGitRepositoryState(args.sourcePath)) {
    case "not_git":
      throw new WorkspaceError(
        "not_git_repo",
        `Cannot create a workspace because the source is not a Git repository: ${args.sourcePath}`,
      );
    case "no_commits":
      throw new WorkspaceError(
        "unborn_head",
        `Cannot create a workspace because the repository has no commits: ${args.sourcePath}`,
      );
    case "has_commits":
      break;
  }
  if (!(await detectColocatedJjSource(args.sourcePath))) {
    throw new WorkspaceError(
      "not_jj_repo",
      `Cannot create a jj workspace because the source is not a colocated Jujutsu repository: ${args.sourcePath}. Run jj git init --colocate there, or pick the Worktree environment instead.`,
    );
  }

  throwIfProvisionAborted(args.signal);
  await fs.mkdir(path.dirname(args.targetPath), { recursive: true });

  const reuseExistingBookmark =
    args.branchMode === "reuse-existing" &&
    (await hasRef(args.sourcePath, `refs/heads/${args.workspaceName}`));
  let baseRevset: string;
  if (reuseExistingBookmark) {
    baseRevset = args.workspaceName;
  } else {
    if (!args.baseBranch) {
      throw new WorkspaceError(
        "missing_default_branch",
        `Cannot resolve default branch for source: ${args.sourcePath}`,
      );
    }
    const base = await resolveJjBase(
      args.sourcePath,
      args.baseBranch,
      args.signal,
    );
    if (base.remote !== null) {
      throwIfProvisionAborted(args.signal);
      await fetchRemoteBase({
        sourcePath: args.sourcePath,
        baseBranch: args.baseBranch,
        remote: base.remote,
        onProgress: args.onProgress,
        signal: args.signal,
      });
    }
    baseRevset = base.revset;
  }

  const startedAt = Date.now();
  emitStep({
    onProgress: args.onProgress,
    key: "jj-workspace-started",
    text: "Creating jj workspace",
    status: "started",
    startedAt,
  });
  let workspaceCreated = false;
  try {
    const jjOptions = { cwd: args.sourcePath, ...signalOptions(args.signal) };
    const commonDir = await getGitCommonDir(args.sourcePath);
    const added = await withWorktreeMetadataLock(
      commonDir,
      () =>
        runJj(
          [
            "workspace",
            "add",
            "--name",
            args.workspaceName,
            args.targetPath,
            "-r",
            baseRevset,
          ],
          jjOptions,
        ),
      args.signal,
    );
    for (const line of (added.stdout + added.stderr).split("\n")) {
      if (line.trim()) emitOutput(args.onProgress, "jj-workspace", line);
    }
    if (!reuseExistingBookmark) {
      await runJj(
        ["bookmark", "set", args.workspaceName, "-r", baseRevset],
        jjOptions,
      );
    }
    await runJj(["git", "export"], jjOptions);
    await attachShadowGitCheckout({
      sourcePath: args.sourcePath,
      workspacePath: args.targetPath,
      ...signalOptions(args.signal),
    });
    emitStep({
      onProgress: args.onProgress,
      key: "jj-workspace-completed",
      text: "Created jj workspace",
      status: "completed",
      startedAt,
      metadata: { durationMs: Date.now() - startedAt },
    });
    workspaceCreated = true;
    await finishWorkspaceSetup(args);
    return { path: args.targetPath };
  } catch (error) {
    if (!workspaceCreated) {
      emitStep({
        onProgress: args.onProgress,
        key: "jj-workspace-failed",
        text: "jj workspace setup failed",
        status: "failed",
        startedAt,
        metadata: { durationMs: Date.now() - startedAt },
      });
    }
    await removeCreateTarget(args);
    throw error;
  }
}

async function removeDirectoryIfEmpty(pathToRemove: string): Promise<void> {
  try {
    await fs.rmdir(pathToRemove);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Forgets the jj workspace, unregisters its shadow git checkout and deletes
 * the directory. The workspace name is read before the directory goes,
 * because jj resolves a workspace's root only while it exists.
 */
export async function removeJjWorkspace(
  args: RemoveJjWorkspaceArgs,
): Promise<void> {
  throwIfProvisionAborted(args.signal);
  const workspacePath = path.resolve(args.path);
  const parentPath = path.dirname(workspacePath);
  try {
    await fs.access(workspacePath);
  } catch {
    await removeDirectoryIfEmpty(parentPath);
    return;
  }

  await experimental_killProcessesWithCwdUnder({ directory: workspacePath });
  throwIfProvisionAborted(args.signal);

  const layout = await resolveJjWorkspaceLayout(workspacePath);
  if (layout?.kind === "secondary") {
    const name = await readJjWorkspaceName(layout.sourcePath, workspacePath);
    if (name !== null) {
      await forgetJjWorkspace(layout.sourcePath, name, args.signal);
    }
  }

  const commonDirResult = await runGit(["rev-parse", "--git-common-dir"], {
    cwd: workspacePath,
    ...signalOptions(args.signal),
    allowFailure: true,
  });
  if (commonDirResult.exitCode === 0) {
    const commonDir = path.resolve(workspacePath, commonDirResult.stdout.trim());
    await withWorktreeMetadataLock(
      commonDir,
      () =>
        runGit(
          ["--git-dir", commonDir, "worktree", "remove", workspacePath, "--force"],
          {
            cwd: parentPath,
            ...signalOptions(args.signal),
            allowFailure: true,
          },
        ),
      args.signal,
    );
  }

  throwIfProvisionAborted(args.signal);
  await fs.rm(workspacePath, { recursive: true, force: true });
  await removeDirectoryIfEmpty(parentPath);
}
