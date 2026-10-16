# Workspace

Creates an isolated [Jujutsu](https://jj-vcs.github.io/jj/) workspace from a colocated project checkout on an enrolled machine, with `jj workspace add`. The thread's work is jj-native: it shows up as that workspace's `@` in `jj log`, `jj op log` can undo it, and bb's commit action runs `jj commit` and moves a bookmark named after the thread branch.

The plugin runs `jj workspace add --colocate`, so the workspace is also a git worktree of the source repository and jj keeps its git HEAD at `@-`. That is what lets bb read status, diffs and files with git. It needs jj 0.46 or newer. Commit with jj, or with bb's commit action, so the bookmark moves with the work.

Bundled and installed automatically. It is only offered for projects whose checkout on the machine is a colocated jj repository (`jj git init --colocate` or `jj git clone --colocate`) and where jj 0.46 or newer is installed. Select it through the environment picker or `bb thread spawn --environment-provider jj-workspace`. Use `bb environment providers --json` for its inputs and availability.

The Plugin Guide documents the experimental environment-provider contract. Core owns durable launches, retries, cancellation, retirement, and teardown; this plugin owns workspace creation and removal.
