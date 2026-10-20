// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Worktree setup, run by the t3.json "Setup Worktree" action as
 * `node scripts/setup-worktree.ts`. Plain Node keeps one command working in
 * every shell T3 Code spawns (zsh, bash, fish, PowerShell): it installs
 * dependencies, links the main checkout's gitignored env files into this
 * worktree, then warms the web dependency cache.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ownedCommand, ownedInstallArgs, readOwnedWorktree } from "./lib/owned-worktree.ts";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup action.");
}
const worktree = NodePath.dirname(import.meta.dirname);
const binding = readOwnedWorktree(worktree);

// `shell` resolves `vp` through PATH, including Windows command shims.
const installCommand = binding
  ? ownedCommand(binding, worktree, ownedInstallArgs(binding, worktree))
  : null;
const install = installCommand
  ? NodeChildProcess.spawnSync(installCommand.command, installCommand.args, {
      cwd: worktree,
      stdio: "inherit",
    })
  : NodeChildProcess.spawnSync("vp i", {
      cwd: worktree,
      shell: true,
      stdio: "inherit",
    });
if (install.status !== 0) process.exit(install.status ?? 1);

// Env files live as real files in the main checkout; worktrees only get
// symlinks to them. Only a symlink is ever replaced, so a real env file is
// never deleted, including when this runs in the main checkout itself.
for (const file of ENV_FILES) {
  const source = NodePath.join(projectRoot, file);
  const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) continue;
  if (!sourceStat.isFile()) {
    process.stderr.write(`Skipping ${file}: ${source} is not a regular file.\n`);
    continue;
  }
  const target = NodePath.join(worktree, file);
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) continue;
  if (existing) NodeFS.rmSync(target);
  NodeFS.symlinkSync(source, target);
}

const warmArgs = [
  process.execPath,
  NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts"),
];
const warmCommand = binding
  ? ownedCommand(binding, worktree, warmArgs)
  : { command: warmArgs[0]!, args: warmArgs.slice(1) };
const warm = NodeChildProcess.spawnSync(warmCommand.command, warmCommand.args, {
  cwd: worktree,
  stdio: "inherit",
});
process.exit(warm.status ?? 1);
