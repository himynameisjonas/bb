import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { createJjWorkspaceHostEntry } from "./host.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

const jjAvailable = await execFileAsync("jj", ["--version"]).then(
  () => true,
  () => false,
);

async function run(
  command: string,
  cwd: string,
  ...args: string[]
): Promise<string> {
  const result = await execFileAsync(command, args, { cwd });
  return result.stdout;
}

async function createColocatedSource(): Promise<{
  root: string;
  sourcePath: string;
  dataDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bb-jj-workspace-plugin-"));
  temporaryRoots.push(root);
  const sourcePath = join(root, "repo");
  const dataDir = join(root, "plugin-data");
  await execFileAsync("mkdir", ["-p", sourcePath, dataDir]);
  await run("jj", sourcePath, "git", "init", "--colocate");
  await run("jj", sourcePath, "config", "set", "--repo", "user.name", "bb");
  await run(
    "jj",
    sourcePath,
    "config",
    "set",
    "--repo",
    "user.email",
    "bb@example.com",
  );
  await writeFile(join(sourcePath, "README.md"), "hello\n");
  await run("jj", sourcePath, "commit", "-m", "initial");
  await run("jj", sourcePath, "bookmark", "create", "main", "-r", "@-");
  return { root, sourcePath, dataDir };
}

function createHarness(dataDir: string) {
  return experimental_createHostEntryHarness(createJjWorkspaceHostEntry(), {
    experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") },
  });
}

function createInput(args: {
  operationId: string;
  sourcePath: string;
  pathKey: string;
  workspaceName: string;
  baseBranch?: string;
}) {
  return {
    operationId: args.operationId,
    sourcePath: args.sourcePath,
    pathKey: args.pathKey,
    workspaceName: args.workspaceName,
    baseBranch:
      args.baseBranch === undefined
        ? { kind: "default" as const }
        : { kind: "named" as const, name: args.baseBranch },
    branchMode: "reset" as const,
  };
}

async function workspaceNames(sourcePath: string): Promise<string[]> {
  const listed = await run(
    "jj",
    sourcePath,
    "workspace",
    "list",
    "-T",
    'name ++ "\\n"',
  );
  return listed.split("\n").filter(Boolean).sort();
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!jjAvailable)("jj workspace host entry", () => {
  it("reports whether a source is a colocated jj repository", async () => {
    const { root, sourcePath, dataDir } = await createColocatedSource();
    const plainGit = join(root, "plain");
    await execFileAsync("mkdir", ["-p", plainGit]);
    await run("git", plainGit, "init", "--initial-branch=main");
    const harness = createHarness(dataDir);
    expect(await harness.experimental_call("inspect", { sourcePath })).toEqual({
      jjAvailable: true,
      colocatedJjSource: true,
    });
    expect(
      await harness.experimental_call("inspect", { sourcePath: plainGit }),
    ).toMatchObject({ colocatedJjSource: false });
    await harness.experimental_dispose();
  });

  it("creates a jj workspace that git can also read, then forgets it", async () => {
    const { sourcePath, dataDir } = await createColocatedSource();
    const harness = createHarness(dataDir);
    const created = await harness.experimental_call(
      "create",
      createInput({
        operationId: "create",
        sourcePath,
        pathKey: "thr_1",
        workspaceName: "bb/thread-1",
      }),
    );
    expect(created).toEqual({
      status: "created",
      path: join(dataDir, "workspaces", "thr_1", "repo"),
      baseBranch: null,
    });
    if (created.status !== "created") throw new Error(created.message);
    expect(await workspaceNames(sourcePath)).toEqual(["bb/thread-1", "default"]);
    expect(existsSync(join(created.path, "README.md"))).toBe(true);
    expect(await run("git", created.path, "rev-parse", "--git-dir")).toContain(
      "/worktrees/",
    );
    expect(
      (await run("git", created.path, "status", "--porcelain")).trim(),
    ).toBe("");
    expect(
      (await run("git", sourcePath, "rev-parse", "refs/heads/bb/thread-1")).trim(),
    ).toBe((await run("git", sourcePath, "rev-parse", "refs/heads/main")).trim());

    expect(
      await harness.experimental_call("remove", {
        operationId: "remove",
        pathKey: "thr_1",
        path: created.path,
      }),
    ).toEqual({ status: "removed" });
    expect(await workspaceNames(sourcePath)).toEqual(["default"]);
    expect(await run("git", sourcePath, "worktree", "list")).not.toContain(
      created.path,
    );
    expect(existsSync(created.path)).toBe(false);
    expect(await readdir(join(dataDir, "workspaces"))).toEqual([]);
    await harness.experimental_dispose();
  });

  it("re-runs create with the same path key without replacing the workspace", async () => {
    const { sourcePath, dataDir } = await createColocatedSource();
    const harness = createHarness(dataDir);
    const input = createInput({
      operationId: "create",
      sourcePath,
      pathKey: "thr_2",
      workspaceName: "bb/thread-2",
    });
    const first = await harness.experimental_call("create", input);
    if (first.status !== "created") throw new Error(first.message);
    await writeFile(join(first.path, "work.txt"), "work\n");
    const second = await harness.experimental_call("create", {
      ...input,
      operationId: "create-again",
    });
    expect(second).toEqual(first);
    expect(await readFile(join(first.path, "work.txt"), "utf8")).toBe("work\n");
    expect(await workspaceNames(sourcePath)).toEqual(["bb/thread-2", "default"]);
    await harness.experimental_dispose();
  });

  it("bases a workspace on a remote-tracking branch", async () => {
    const { root, sourcePath: upstream, dataDir } =
      await createColocatedSource();
    const remotePath = join(root, "remote.git");
    await run("git", root, "clone", "--bare", upstream, remotePath);
    const clonePath = join(root, "clone");
    await run("jj", root, "git", "clone", "--colocate", remotePath, clonePath);

    await writeFile(join(upstream, "later.txt"), "later\n");
    await run("jj", upstream, "commit", "-m", "later");
    await run("jj", upstream, "bookmark", "set", "main", "-r", "@-");
    await run("git", upstream, "push", remotePath, "refs/heads/main:refs/heads/main");

    const harness = createHarness(dataDir);
    const created = await harness.experimental_call(
      "create",
      createInput({
        operationId: "create",
        sourcePath: clonePath,
        pathKey: "thr_3",
        workspaceName: "bb/thread-3",
        baseBranch: "origin/main",
      }),
    );
    expect(created).toMatchObject({ status: "created", baseBranch: "origin/main" });
    if (created.status !== "created") throw new Error(created.message);
    expect((await run("git", created.path, "rev-parse", "HEAD")).trim()).toBe(
      (await run("git", remotePath, "rev-parse", "refs/heads/main")).trim(),
    );
    expect(existsSync(join(created.path, "later.txt"))).toBe(true);
    await harness.experimental_dispose();
  });

  it("leaves nothing registered when the base does not exist", async () => {
    const { sourcePath, dataDir } = await createColocatedSource();
    const harness = createHarness(dataDir);
    const result = await harness.experimental_call(
      "create",
      createInput({
        operationId: "create",
        sourcePath,
        pathKey: "thr_4",
        workspaceName: "bb/thread-4",
        baseBranch: "no-such-branch",
      }),
    );
    expect(result.status).toBe("failed");
    expect(await workspaceNames(sourcePath)).toEqual(["default"]);
    expect(existsSync(join(dataDir, "workspaces", "thr_4"))).toBe(false);
    await harness.experimental_dispose();
  });

  it("refuses a plain git source with a typed message", async () => {
    const { root, dataDir } = await createColocatedSource();
    const plainGit = join(root, "plain");
    await execFileAsync("mkdir", ["-p", plainGit]);
    await run("git", plainGit, "init", "--initial-branch=main");
    await writeFile(join(plainGit, "README.md"), "hello\n");
    await run("git", plainGit, "add", ".");
    await run("git", plainGit, "-c", "user.name=bb", "-c", "user.email=bb@example.com", "commit", "-m", "initial");
    const harness = createHarness(dataDir);
    const result = await harness.experimental_call(
      "create",
      createInput({
        operationId: "create",
        sourcePath: plainGit,
        pathKey: "thr_5",
        workspaceName: "bb/thread-5",
      }),
    );
    expect(result).toMatchObject({
      status: "failed",
      message: expect.stringContaining("not a colocated Jujutsu repository"),
    });
    await harness.experimental_dispose();
  });
});
