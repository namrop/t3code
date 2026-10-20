// @effect-diagnostics nodeBuiltinImport:off - used before dependency installation.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const fs = NodeFS;
const path = NodePath;

export interface OwnedWorktreeBinding {
  schemaVersion: 1;
  manifest: string;
  homeId: string;
  runId: string;
  cacheHomeId: string;
  cacheRunId: string;
  owner: string;
  payload: string;
  retained: string;
  worktreePath: string;
  physicalWorktreePath: string;
  publishedRoot: string;
  physicalRoot: string;
  cachePayload: string;
  producerCommand: string;
  bindingPath: string;
  sourceRepo: string;
  sourceCommit: string;
  sourceCommonDir: string;
}

const fields = [
  "manifest",
  "homeId",
  "runId",
  "cacheHomeId",
  "cacheRunId",
  "owner",
  "payload",
  "retained",
  "worktreePath",
  "physicalWorktreePath",
  "publishedRoot",
  "physicalRoot",
  "cachePayload",
  "producerCommand",
  "bindingPath",
  "sourceRepo",
  "sourceCommit",
  "sourceCommonDir",
] as const;
const paths = [
  "manifest",
  "payload",
  "retained",
  "worktreePath",
  "physicalWorktreePath",
  "publishedRoot",
  "physicalRoot",
  "cachePayload",
  "producerCommand",
  "bindingPath",
  "sourceRepo",
  "sourceCommonDir",
] as const;

export function readOwnedWorktree(root: string): OwnedWorktreeBinding | null {
  const marker = path.join(root, ".pharos-owned-worktree.json");
  if (!fs.existsSync(marker)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (
      value.schemaVersion !== 1 ||
      fields.some((key) => typeof value[key] !== "string" || !value[key]) ||
      paths.some((key) => !path.isAbsolute(value[key]))
    ) {
      throw new Error("Invalid owned worktree marker");
    }
    const retained = JSON.parse(fs.readFileSync(value.bindingPath, "utf8"));
    if (retained.schemaVersion !== 1 || fields.some((key) => retained[key] !== value[key])) {
      throw new Error("Owned worktree marker differs from retained binding");
    }
    // This is a pointer, not lifecycle authority. The immutable producer checks
    // current records, identities and cwd again before each command.
    return value as OwnedWorktreeBinding;
  } catch (cause) {
    throw new Error("Invalid owned worktree marker or retained binding", { cause });
  }
}

export function ownedCommand(binding: OwnedWorktreeBinding, cwd: string, argv: readonly string[]) {
  return {
    command: binding.producerCommand,
    args: [
      "--manifest",
      binding.manifest,
      "--home",
      binding.homeId,
      "use-worktree",
      "--binding",
      binding.bindingPath,
      "--cwd",
      cwd,
      "--",
      ...argv,
    ],
  };
}

export function hasOwnedConsumers(binding: OwnedWorktreeBinding, env: NodeJS.ProcessEnv): boolean {
  if (env.PHAROS_WORKTREE_CONSUMER !== binding.runId) return false;
  try {
    const fds = [env.PHAROS_WORKTREE_LEASE_FD, env.PHAROS_CACHE_LEASE_FD].map((value) => {
      if (!value || !/^\d+$/.test(value) || Number(value) < 3)
        throw new Error("Missing inherited consumer FD");
      return fs.fstatSync(Number(value));
    });
    return (
      fds.every((stat) => stat.isFile()) &&
      !(fds[0]!.dev === fds[1]!.dev && fds[0]!.ino === fds[1]!.ino)
    );
  } catch {
    return false;
  }
}

export function ownedInstallArgs(binding: OwnedWorktreeBinding, root: string) {
  const { packageManager } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (typeof packageManager !== "string" || !/^pnpm@\d+\.\d+\.\d+(?:\+.*)?$/.test(packageManager))
    throw new Error("Owned setup requires a pinned pnpm packageManager");
  return [
    "pnpm",
    "install",
    "--frozen-lockfile",
    "--store-dir",
    path.join(binding.cachePayload, "pnpm"),
    "--virtual-store-dir",
    path.join(root, "node_modules/.pnpm"),
    "--manage-package-manager-versions",
  ];
}

/** Replace, rather than nest, the launcher with the native lifecycle supervisor.
 * Its direct Node child holds both leases for the full Effect runner lifetime.
 * Effect's additionalFds makes pipes, not inherited arbitrary descriptors; Vite
 * descendants are therefore supervised by that runner, not claimed as holders.
 */
export function reexecOwnedDev(root: string, argv: readonly string[]): void {
  const binding = readOwnedWorktree(root);
  if (!binding || hasOwnedConsumers(binding, process.env)) return;
  if (!process.execve)
    throw new Error("Owned dev requires Node execve; refusing an unleased dev runner");
  const command = ownedCommand(binding, root, argv);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  process.execve(command.command, [command.command, ...command.args], env);
}
