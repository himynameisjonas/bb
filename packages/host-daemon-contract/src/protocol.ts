// Version 217 supports Jujutsu sources. The `detached` checkout variant can
// carry a `jj` object naming the bookmark at HEAD, `workspace.commit` refuses
// to run in a jj main workspace with a typed `jj_workspace` error the server
// maps to 409, and the daemon reads a `jj workspace add` workspace through
// its shadow git checkout, committing with jj. An older daemon reports no jj
// checkouts and would commit such a workspace with git, so the bump forces
// enrolled machines to update.
export const HOST_DAEMON_PROTOCOL_VERSION = 217 as const;

export const HOST_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;

export const HOST_DAEMON_TERMINAL_EXIT_RETENTION_MS = 30 * 60 * 1000;
