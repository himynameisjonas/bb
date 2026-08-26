import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runGit } from "bb-environment-provider-host/workspace-git";
import { JjWorkspace } from "../src/jj-workspace.js";
import {
  attachShadowGitCheckout,
  resolveJjWorkspaceLayout,
  runJj,
  type JjWorkspaceLayout,
} from "bb-environment-provider-host/jj";

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

async function initSource(): Promise<string> {
  const sourcePath = await makeTempDir("bb-jj-source-");
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

async function addWorkspace(
  sourcePath: string,
  bookmark: string,
): Promise<{ workspace: JjWorkspace; workspacePath: string }> {
  const parent = await makeTempDir("bb-jj-workspaces-");
  const workspacePath = path.join(parent, "thread");
  await runJj(
    ["workspace", "add", "--name", bookmark, workspacePath, "-r", "main"],
    { cwd: sourcePath },
  );
  await attachShadowGitCheckout({ sourcePath, workspacePath });
  const layout = (await resolveJjWorkspaceLayout(
    workspacePath,
  )) as JjWorkspaceLayout;
  return {
    workspace: new JjWorkspace({
      path: workspacePath,
      isWorktree: true,
      layout,
      bookmark,
    }),
    workspacePath,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe.skipIf(!jjAvailable)("bb-managed jj workspaces", () => {
  it("reports jj's working-copy edits through git without .jj noise", async () => {
    const sourcePath = await initSource();
    const { workspace, workspacePath } = await addWorkspace(
      sourcePath,
      "bb/thread-1",
    );
    const idle = await workspace.getLocalStateSnapshot();

    await fs.writeFile(path.join(workspacePath, "README.md"), "edited\n", "utf8");
    await fs.writeFile(path.join(workspacePath, "added.txt"), "added\n", "utf8");

    const dirty = await workspace.getLocalStateSnapshot();
    expect(dirty.fingerprint).not.toBe(idle.fingerprint);
    const porcelain = (
      await runGit(["status", "--porcelain"], { cwd: workspacePath })
    ).stdout;
    expect(porcelain).toContain("README.md");
    expect(porcelain).toContain("added.txt");
    expect(porcelain).not.toContain(".jj");
  });

  it("commits with jj, moves the bookmark, and exports it to git", async () => {
    const sourcePath = await initSource();
    const { workspace, workspacePath } = await addWorkspace(
      sourcePath,
      "bb/thread-1",
    );
    await fs.writeFile(path.join(workspacePath, "work.txt"), "work\n", "utf8");

    const result = await workspace.commit({
      message: "thread work",
      noVerify: true,
    });
    expect(result.commitSubject).toBe("thread work");

    // The bookmark is a real git ref in the source repository...
    const ref = await runGit(
      ["rev-parse", "--verify", "refs/heads/bb/thread-1"],
      { cwd: sourcePath },
    );
    expect(ref.stdout.trim()).toBe(result.commitSha);
    // ...and jj sees one commit, not a stray anonymous head beside it.
    const heads = await runJj(
      ["log", "--no-graph", "-r", "bb/thread-1", "-T", 'description.first_line() ++ "\\n"'],
      { cwd: sourcePath },
    );
    expect(heads.stdout.trim()).toBe("thread work");

    expect(
      (await runGit(["status", "--porcelain"], { cwd: workspacePath })).stdout.trim(),
    ).toBe("");
  });

  it("refuses an empty commit", async () => {
    const sourcePath = await initSource();
    const { workspace } = await addWorkspace(sourcePath, "bb/thread-1");

    await expect(
      workspace.commit({ message: "nothing", noVerify: true }),
    ).rejects.toMatchObject({ name: "WorkspaceError", code: "no_changes" });
  });


  it("keeps the local fingerprint stable across repeated reads", async () => {
    const sourcePath = await initSource();
    const { workspace, workspacePath } = await addWorkspace(
      sourcePath,
      "bb/thread-1",
    );

    // Every read snapshots the working copy. If that made the fingerprint
    // move on its own, the watcher would re-read forever.
    const idle = (await workspace.getLocalStateSnapshot()).fingerprint;
    expect((await workspace.getLocalStateSnapshot()).fingerprint).toBe(idle);
    expect((await workspace.getLocalStateSnapshot()).fingerprint).toBe(idle);

    await fs.writeFile(path.join(workspacePath, "work.txt"), "work\n", "utf8");
    const dirty = (await workspace.getLocalStateSnapshot()).fingerprint;
    expect(dirty).not.toBe(idle);
    expect((await workspace.getLocalStateSnapshot()).fingerprint).toBe(dirty);
  });

  it("picks up commits an agent made with jj directly", async () => {
    const sourcePath = await initSource();
    const { workspace, workspacePath } = await addWorkspace(
      sourcePath,
      "bb/thread-1",
    );
    await fs.writeFile(path.join(workspacePath, "agent.txt"), "agent\n", "utf8");
    // An agent using jj moves @- without bb involvement; the shadow checkout
    // has to follow before anything reads the workspace.
    await runJj(["commit", "-m", "agent commit"], { cwd: workspacePath });

    expect(await workspace.getHeadSha()).toBe(
      (
        await runJj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"], {
          cwd: workspacePath,
        })
      ).stdout.trim(),
    );
  });
});
