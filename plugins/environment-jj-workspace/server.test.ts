import type {
  PluginEnvironmentProviderAvailabilityContext,
  PluginEnvironmentProviderCreateContext,
  PluginEnvironmentProviderProgress,
} from "@get-bb/plugin-sdk/environment-provider";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { JJ_WORKSPACE_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";
import plugin from "./server.js";

type Project = PluginEnvironmentProviderCreateContext["project"];
type HostRpcCall = FakePluginHarness["experimental_hostRpcCalls"][number];

const HOST_ID = "host-a";
const PROJECT_ID = "project-1";
const THREAD_ID = "thr_1";
const SOURCE_PATH = "/checkouts/bb";
const WORKSPACE_PATH =
  "/data/plugins/environment-jj-workspace/workspaces/thr_1/bb";

const HOST = makeHostResponse({ id: HOST_ID, name: "Fake machine" });
const PROJECT: Project = {
  id: PROJECT_ID,
  kind: "standard",
  name: "bb",
  gitRemoteUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

async function setup(
  inspect: { jjAvailable: boolean; colocatedJjSource: boolean } = {
    jjAvailable: true,
    colocatedJjSource: true,
  },
) {
  const callHost = (call: HostRpcCall) => {
    if (call.method === "inspect") return inspect;
    if (call.method === "create") {
      return { status: "created", path: WORKSPACE_PATH, baseBranch: "main" };
    }
    if (call.method === "remove") return { status: "removed" };
    throw new Error(`unexpected host method ${call.method}`);
  };
  const { bb, harness } = createFakePluginHost({
    experimental_callHostRpc: callHost,
  });
  await plugin(bb);
  const provider = harness.registrations.environmentProviders.get(
    JJ_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
  );
  if (provider === undefined) throw new Error("Provider not registered");
  const report: PluginEnvironmentProviderProgress = {
    step: () => {},
    log: () => {},
  };
  const availabilityContext: PluginEnvironmentProviderAvailabilityContext = {
    project: PROJECT,
    host: HOST,
    projectCheckout: { path: SOURCE_PATH },
    gitRemote: null,
  };
  const createContext: PluginEnvironmentProviderCreateContext = {
    thread: makeThreadResponse({ id: THREAD_ID, projectId: PROJECT_ID }),
    project: PROJECT,
    host: HOST,
    projectCheckout: { experimental_ownsPath: false, path: SOURCE_PATH },
    gitRemote: null,
    inputs: { branch: { kind: "default" } },
    suggestedBranchName: "bb/test",
    attempt: 1,
    pathKey: THREAD_ID,
    rebuild: false,
    experimental_claimPath: async () => true,
    previous: null,
    report,
    signal: new AbortController().signal,
  };
  return { provider, harness, availabilityContext, createContext };
}

describe("jj workspace provider", () => {
  it("registers as Workspace with per-attempt path keys", async () => {
    const { provider } = await setup();
    expect(provider.displayName).toBe("Workspace");
    expect(provider.policy.pathKeys).toBe("per-attempt");
  });

  it("is only available on machines whose checkout is a colocated jj repository", async () => {
    const colocated = await setup();
    expect(
      await colocated.provider.availability?.(colocated.availabilityContext),
    ).toEqual({ status: "available" });
    expect(colocated.harness.experimental_hostRpcCalls[0]).toMatchObject({
      method: "inspect",
      hostId: HOST_ID,
      input: { sourcePath: SOURCE_PATH },
    });

    const plainGit = await setup({ jjAvailable: true, colocatedJjSource: false });
    expect(
      await plainGit.provider.availability?.(plainGit.availabilityContext),
    ).toMatchObject({ status: "unavailable" });

    const noJj = await setup({ jjAvailable: false, colocatedJjSource: false });
    expect(await noJj.provider.availability?.(noJj.availabilityContext)).toEqual(
      { status: "unavailable", message: "jj is not installed on this machine" },
    );

    const noCheckout = await setup();
    expect(
      await noCheckout.provider.availability?.({
        ...noCheckout.availabilityContext,
        projectCheckout: null,
      }),
    ).toMatchObject({ status: "unavailable" });
  });

  it("creates through the host and reports the owned path", async () => {
    const { provider, harness, createContext } = await setup();
    expect(await provider.create(createContext)).toEqual({
      status: "created",
      path: WORKSPACE_PATH,
      ownsPath: true,
      mergeBaseBranch: "main",
    });
    expect(harness.experimental_hostRpcCalls[0]).toMatchObject({
      method: "create",
      hostId: HOST_ID,
      input: {
        operationId: `create#${THREAD_ID}#1`,
        workspaceName: "bb/test",
        pathKey: THREAD_ID,
        baseBranch: { kind: "default" },
        branchMode: "reset",
      },
    });
  });

  it("reuses the previous bookmark when rebuilding", async () => {
    const { provider, harness, createContext } = await setup();
    await provider.create({
      ...createContext,
      rebuild: true,
      suggestedBranchName: "bb/renamed",
      previous: {
        environment: {
          id: "env-retired",
          name: null,
          projectId: PROJECT_ID,
          hostId: HOST_ID,
          path: WORKSPACE_PATH,
          isGitRepo: true,
          isWorktree: true,
          branchName: "bb/original",
          baseBranch: "main",
          defaultBranch: "main",
          mergeBaseBranch: "main",
          status: "destroyed",
          environmentProviderId: JJ_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
          lifecycle: {
            phase: "destroyed",
            retireAt: null,
            teardown: { status: "removed", attempt: 1 },
          },
          environmentProviderSelection: null,
          environmentProviderInstanceKey: THREAD_ID,
          managed: true,
          workspaceProvisionType: "managed-worktree",
          createdAt: 1,
          updatedAt: 2,
        },
        resource: null,
      },
      pathKey: "replacement",
      attempt: 2,
    });
    expect(harness.experimental_hostRpcCalls[0]?.input).toMatchObject({
      workspaceName: "bb/original",
      branchMode: "reuse-existing",
    });
  });
});
