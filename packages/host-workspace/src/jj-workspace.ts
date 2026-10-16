import {
  WorkspaceError,
  runGit,
  type GitProcessOptions,
} from "bb-environment-provider-host/workspace-git";
import {
  readJjWorkingCopyCommits,
  runJj,
  withJjRepoLock,
  type JjWorkspaceLayout,
} from "bb-environment-provider-host/jj";
import {
  Workspace,
  type CommitOptions,
  type CommitResult,
} from "./host-workspace.js";

export class JjWorkspace extends Workspace {
  readonly layout: JjWorkspaceLayout;
  readonly bookmark: string;
  private readonly jjProcessOptions: GitProcessOptions;

  constructor(args: {
    path: string;
    isWorktree: boolean;
    layout: JjWorkspaceLayout;
    bookmark: string;
    shellPath?: string;
  }) {
    super({
      path: args.path,
      isGitRepo: true,
      isWorktree: args.isWorktree,
      ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    });
    this.layout = args.layout;
    this.bookmark = args.bookmark;
    this.jjProcessOptions =
      args.shellPath === undefined ? {} : { shellPath: args.shellPath };
  }

  override async commit(options: CommitOptions): Promise<CommitResult> {
    return withJjRepoLock(this.layout, async () => {
      const before = await readJjWorkingCopyCommits(
        this.path,
        this.jjProcessOptions,
      );
      if (await this.isWorkingCopyEmpty()) {
        throw new WorkspaceError("no_changes", "No changes to commit");
      }

      await runJj(["commit", "-m", options.message], {
        cwd: this.path,
        ...this.jjProcessOptions,
      });
      const after = await readJjWorkingCopyCommits(
        this.path,
        this.jjProcessOptions,
      );
      await runJj(["bookmark", "set", this.bookmark, "-r", after.parent], {
        cwd: this.path,
        ...this.jjProcessOptions,
      });
      await this.exportBookmark(after.parent);

      if (after.parent === before.parent) {
        throw new WorkspaceError(
          "jj_command_failed",
          "jj commit did not advance the working-copy parent",
        );
      }
      const commitSubject = (
        await runGit(["log", "-1", "--pretty=%s", after.parent], {
          cwd: this.path,
          ...this.jjProcessOptions,
        })
      ).stdout.trim();
      return { commitSha: after.parent, commitSubject };
    });
  }

  private async isWorkingCopyEmpty(): Promise<boolean> {
    const result = await runJj(
      ["log", "--no-graph", "-r", "@", "-T", 'if(empty, "empty", "changed")'],
      { cwd: this.path, ...this.jjProcessOptions },
    );
    return result.stdout.trim() === "empty";
  }

  private async exportBookmark(expectedSha: string): Promise<void> {
    await runJj(["git", "export"], {
      cwd: this.path,
      ...this.jjProcessOptions,
    });
    if (await this.bookmarkRefMatches(expectedSha)) {
      return;
    }

    await runJj(["git", "import"], {
      cwd: this.path,
      ...this.jjProcessOptions,
    });
    await runJj(["bookmark", "set", this.bookmark, "-r", expectedSha], {
      cwd: this.path,
      ...this.jjProcessOptions,
    });
    await runJj(["git", "export"], {
      cwd: this.path,
      ...this.jjProcessOptions,
    });
    if (!(await this.bookmarkRefMatches(expectedSha))) {
      throw new WorkspaceError(
        "jj_export_failed",
        `Could not export bookmark ${this.bookmark} to git`,
      );
    }
  }

  private async bookmarkRefMatches(expectedSha: string): Promise<boolean> {
    const ref = await runGit(
      ["rev-parse", "--verify", `refs/heads/${this.bookmark}`],
      { cwd: this.path, allowFailure: true, ...this.jjProcessOptions },
    );
    return ref.exitCode === 0 && ref.stdout.trim() === expectedSha;
  }
}
