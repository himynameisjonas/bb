import type { ProvisioningTranscriptEntry, WorkspaceStatus } from "@bb/domain";
import { pathExists } from "@bb/process-utils";
import type {
  CommitOptions,
  CommitResult,
  DiffOptions,
  DiffResult,
  DiffFilesArgs,
  DiffFilesResult,
  DiffPatchArgs,
  DiffPatchEntry,
  PullRequestActionOptions,
  StatusOptions,
} from "./workspace.js";
import { Workspace } from "./workspace.js";
import { JjWorkspace } from "./jj-workspace.js";
import {
  readJjWorkspaceName,
  resolveJjWorkspaceLayout,
} from "bb-environment-provider-host/jj";
import type {
  GitHostCliOptions,
  GitHostPullRequestLookup,
} from "./git-host.js";
import {
  detectGitRepo,
  detectLinkedWorktree,
  readDefaultBranch,
  WorkspaceError,
  type GitProcessOptions,
} from "./git.js";
import { resolveAdditionalWorkspaceWriteRoots } from "./workspace-write-roots.js";

type ProvisionProgressCallback = (entry: ProvisioningTranscriptEntry) => void;

function createProvisionCancelledError(cause?: unknown): WorkspaceError {
  return new WorkspaceError(
    "provision_cancelled",
    "Workspace provisioning was cancelled",
    { cause },
  );
}

export function throwIfProvisionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createProvisionCancelledError(signal.reason);
  }
}

interface ProvisionBase {
  onProgress?: ProvisionProgressCallback;
  shellPath?: string;
  signal?: AbortSignal;
}

interface UnmanagedWorkspaceOpts extends ProvisionBase {
  path: string;
}

export type ProvisionWorkspaceArgs = UnmanagedWorkspaceOpts;

const WORKSPACE_BRANCH_GIT_TIMEOUT_MS = 15_000;

export interface HostWorkspace {
  readonly path: string;
  readonly isGitRepo: boolean;
  readonly isWorktree: boolean;

  getDefaultBranch(): Promise<string | null>;
  getCurrentBranch(): Promise<string | null>;
  getHeadSha(): Promise<string | null>;
  getLocalStateFingerprint(): Promise<string>;
  getSharedGitRefsFingerprint(): Promise<string>;
  getAdditionalWorkspaceWriteRoots(): Promise<string[]>;
  getStatus(options?: StatusOptions): Promise<WorkspaceStatus>;
  getDiff(options?: DiffOptions): Promise<DiffResult>;
  diffFiles(args: DiffFilesArgs): Promise<DiffFilesResult>;
  diffPatch(args: DiffPatchArgs): Promise<DiffPatchEntry[]>;
  getPullRequest(
    options?: GitHostCliOptions,
  ): Promise<GitHostPullRequestLookup>;
  runPullRequestAction(
    action: PullRequestActionOptions,
    options?: GitHostCliOptions,
  ): Promise<void>;

  commit(options: CommitOptions): Promise<CommitResult>;
}

class ProvisionedHostWorkspace implements HostWorkspace {
  readonly path: string;
  readonly isGitRepo: boolean;
  readonly isWorktree: boolean;

  private readonly ws: Workspace;
  private readonly gitProcessOptions: GitProcessOptions;

  constructor(opts: {
    path: string;
    isGitRepo: boolean;
    isWorktree: boolean;
    shellPath?: string;
    workspace?: Workspace;
  }) {
    this.path = opts.path;
    this.isGitRepo = opts.isGitRepo;
    this.isWorktree = opts.isWorktree;
    this.gitProcessOptions = {
      ...(opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {}),
    };
    this.ws =
      opts.workspace ?? new Workspace(opts.path, this.gitProcessOptions);
  }

  async getCurrentBranch(): Promise<string | null> {
    return (await this.ws.currentBranch) ?? null;
  }

  async getDefaultBranch(): Promise<string | null> {
    if (!this.isGitRepo) {
      return null;
    }
    return (
      (await readDefaultBranch(this.path, {
        timeoutMs: WORKSPACE_BRANCH_GIT_TIMEOUT_MS,
        ...this.gitProcessOptions,
      })) ?? null
    );
  }

  getHeadSha(): Promise<string | null> {
    return this.ws.getHeadSha();
  }

  getLocalStateFingerprint(): Promise<string> {
    return this.ws.getLocalStateFingerprint();
  }

  getSharedGitRefsFingerprint(): Promise<string> {
    return this.ws.getSharedGitRefsFingerprint();
  }

  getAdditionalWorkspaceWriteRoots(): Promise<string[]> {
    if (!this.isGitRepo || !this.isWorktree) {
      return Promise.resolve([]);
    }
    return resolveAdditionalWorkspaceWriteRoots(
      this.path,
      this.gitProcessOptions,
    );
  }

  getStatus(options?: StatusOptions): Promise<WorkspaceStatus> {
    return this.ws.getStatus(options);
  }

  getDiff(options?: DiffOptions): Promise<DiffResult> {
    return this.ws.getDiff(options);
  }

  diffFiles(args: DiffFilesArgs): Promise<DiffFilesResult> {
    return this.ws.diffFiles(args);
  }

  diffPatch(args: DiffPatchArgs): Promise<DiffPatchEntry[]> {
    return this.ws.diffPatch(args);
  }

  getPullRequest(
    options?: GitHostCliOptions,
  ): Promise<GitHostPullRequestLookup> {
    return this.ws.getPullRequest(options);
  }

  runPullRequestAction(
    action: PullRequestActionOptions,
    options?: GitHostCliOptions,
  ): Promise<void> {
    return this.ws.runPullRequestAction(action, options);
  }

  commit(options: CommitOptions): Promise<CommitResult> {
    return this.ws.commit(options);
  }
}

/**
 * Builds the workspace implementation for a path: a {@link JjWorkspace} when
 * the path is a `jj workspace add` workspace with a shadow git checkout, a
 * plain {@link Workspace} otherwise.
 *
 * The jj bookmark carrying the workspace's committed work is named after the
 * workspace itself, so it is read back from jj rather than remembered. A
 * daemon restart therefore resolves the same bookmark from the path alone.
 */
async function createWorkspaceForPath(
  wsPath: string,
  options: GitProcessOptions,
): Promise<Workspace> {
  const layout = await resolveJjWorkspaceLayout(wsPath);
  if (layout?.kind !== "secondary") {
    return new Workspace(wsPath, options);
  }
  const bookmark = await readJjWorkspaceName(layout.sourcePath, wsPath, options);
  if (!bookmark) {
    return new Workspace(wsPath, options);
  }
  return new JjWorkspace({ path: wsPath, layout, bookmark, options });
}

export function provisionWorkspace(
  opts: ProvisionWorkspaceArgs,
): Promise<HostWorkspace> {
  return provisionUnmanaged(opts);
}

async function provisionUnmanaged(
  opts: UnmanagedWorkspaceOpts,
): Promise<HostWorkspace> {
  throwIfProvisionAborted(opts.signal);
  if (!(await pathExists(opts.path))) {
    throw new WorkspaceError(
      "path_not_found",
      `Unmanaged workspace path does not exist: ${opts.path}`,
    );
  }
  const isGitRepo = await detectGitRepo(opts.path, {
    ...(opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {}),
  });
  const gitProcessOptions =
    opts.shellPath === undefined ? {} : { shellPath: opts.shellPath };
  const isWorktree = isGitRepo
    ? await detectLinkedWorktree(opts.path, gitProcessOptions)
    : false;

  return new ProvisionedHostWorkspace({
    path: opts.path,
    isGitRepo,
    isWorktree,
    shellPath: opts.shellPath,
    workspace: isGitRepo
      ? await createWorkspaceForPath(opts.path, gitProcessOptions)
      : undefined,
  });
}
