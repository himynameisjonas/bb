import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachShadowGitCheckout,
  runJj,
} from "bb-environment-provider-host/jj";
import { runGit } from "../src/git.js";
import { provisionWorkspace } from "../src/provision.js";
import { resolveAdditionalWorkspaceWriteRoots } from "../src/workspace-write-roots.js";

const execFileAsync = promisify(execFile);

const jjAvailable = await execFileAsync("jj", ["--version"]).then(
  () => true,
  () => false,
);

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return await fs.realpath(dir);
}

async function initColocatedSource(): Promise<string> {
  const sourcePath = await makeTempDir("bb-jj-provision-source-");
  await runJj(["git", "init", "--colocate"], { cwd: sourcePath });
  await runJj(["config", "set", "--repo", "user.name", "BB Tests"], {
    cwd: sourcePath,
  });
  await runJj(["config", "set", "--repo", "user.email", "bb@example.com"], {
    cwd: sourcePath,
  });
  await fs.writeFile(path.join(sourcePath, "README.md"), "hello\n", "utf8");
  await runJj(["commit", "-m", "Initial commit"], { cwd: sourcePath });
  await runJj(["bookmark", "create", "main", "-r", "@-"], { cwd: sourcePath });
  return sourcePath;
}

async function addShadowedWorkspace(
  sourcePath: string,
  name: string,
): Promise<string> {
  const parent = await makeTempDir("bb-jj-provision-target-");
  const workspacePath = path.join(parent, "repo");
  await runJj(["workspace", "add", "--name", name, workspacePath, "-r", "main"], {
    cwd: sourcePath,
  });
  await attachShadowGitCheckout({ sourcePath, workspacePath });
  return workspacePath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe.skipIf(!jjAvailable)("provisioning a jj workspace path", () => {
  it("commits through jj and reports the workspace as a worktree", async () => {
    const sourcePath = await initColocatedSource();
    const workspacePath = await addShadowedWorkspace(sourcePath, "bb/thread-1");

    const hostWorkspace = await provisionWorkspace({ path: workspacePath });
    expect(hostWorkspace.isGitRepo).toBe(true);
    expect(hostWorkspace.isWorktree).toBe(true);

    await fs.writeFile(path.join(workspacePath, "work.txt"), "work\n", "utf8");
    const status = await hostWorkspace.getStatus();
    expect(status.workingTree.files.map((file) => file.path)).toEqual([
      "work.txt",
    ]);

    const commit = await hostWorkspace.commit({
      message: "thread work",
      noVerify: true,
    });
    const bookmark = await runJj(
      ["log", "--no-graph", "-r", "bb/thread-1", "-T", "commit_id"],
      { cwd: sourcePath },
    );
    expect(bookmark.stdout.trim()).toBe(commit.commitSha);
  });

  it("grants agents write access to the repository state outside the workspace", async () => {
    const sourcePath = await initColocatedSource();
    const workspacePath = await addShadowedWorkspace(sourcePath, "bb/thread-1");

    const hostWorkspace = await provisionWorkspace({ path: workspacePath });
    const roots = await hostWorkspace.getAdditionalWorkspaceWriteRoots();
    expect(roots).toContain(path.join(sourcePath, ".jj", "repo"));
    expect(roots).toContain(path.join(sourcePath, ".git", "objects"));
    expect(await resolveAdditionalWorkspaceWriteRoots(workspacePath)).toEqual(
      roots,
    );
  });

  it("still commits plain git worktrees with git", async () => {
    const sourcePath = await makeTempDir("bb-jj-plain-source-");
    await runGit(["init", "-b", "main"], { cwd: sourcePath });
    await runGit(["config", "user.name", "BB Tests"], { cwd: sourcePath });
    await runGit(["config", "user.email", "bb@example.com"], { cwd: sourcePath });
    await fs.writeFile(path.join(sourcePath, "README.md"), "hello\n", "utf8");
    await runGit(["add", "."], { cwd: sourcePath });
    await runGit(["commit", "-m", "Initial commit"], { cwd: sourcePath });
    const parent = await makeTempDir("bb-jj-plain-target-");
    const worktreePath = path.join(parent, "repo");
    await runGit(["worktree", "add", "-B", "bb/thread-1", worktreePath, "main"], {
      cwd: sourcePath,
    });
    await runGit(["config", "user.name", "BB Tests"], { cwd: worktreePath });
    await runGit(["config", "user.email", "bb@example.com"], { cwd: worktreePath });

    const hostWorkspace = await provisionWorkspace({ path: worktreePath });
    await fs.writeFile(path.join(worktreePath, "work.txt"), "work\n", "utf8");
    const commit = await hostWorkspace.commit({ message: "git work", noVerify: true });
    const head = await runGit(["rev-parse", "bb/thread-1"], { cwd: sourcePath });
    expect(head.stdout.trim()).toBe(commit.commitSha);
  });
});
