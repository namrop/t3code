// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test } from "vitest";

const dirs: string[] = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-worktree-"));
  dirs.push(root);
  const binding = {
    schemaVersion: 1,
    manifest: path.join(root, "manifest.json"),
    homeId: "work",
    runId: "job",
    cacheHomeId: "cache",
    cacheRunId: "cache-run",
    owner: "owner",
    payload: root,
    retained: path.join(root, "retained"),
    worktreePath: root,
    physicalWorktreePath: root,
    publishedRoot: root,
    physicalRoot: root,
    cachePayload: path.join(root, "cache"),
    producerCommand: path.join(root, "producer"),
    bindingPath: path.join(root, "retained/binding.json"),
    sourceRepo: root,
    sourceCommit: "abc",
    sourceCommonDir: path.join(root, ".git"),
  };
  fs.mkdirSync(binding.retained);
  fs.writeFileSync(binding.bindingPath, JSON.stringify(binding));
  return { root, binding };
};
afterEach(() => {
  for (const root of dirs.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const load = async () => {
  const module = await import("./owned-worktree.ts").catch(() => null);
  expect(module, "owned lifecycle helper must be available before install").not.toBeNull();
  return module!;
};
test("missing marker remains legacy; malformed marker refuses rather than falling back", async () => {
  const helper = await load();
  const { root } = fixture();
  expect(helper.readOwnedWorktree(root)).toBeNull();
  fs.writeFileSync(path.join(root, ".pharos-owned-worktree.json"), "{}");
  expect(() => helper.readOwnedWorktree(root)).toThrow(/owned worktree/i);
});
test("uses retained immutable producer, manifest, home and binding in the exact prefix", async () => {
  const helper = await load();
  const { root, binding } = fixture();
  fs.writeFileSync(path.join(root, ".pharos-owned-worktree.json"), JSON.stringify(binding));
  expect(helper.readOwnedWorktree(root)).toEqual(binding);
  expect(helper.ownedCommand(binding, root, ["node", "script.ts"])).toEqual({
    command: binding.producerCommand,
    args: [
      "--manifest",
      binding.manifest,
      "--home",
      "work",
      "use-worktree",
      "--binding",
      binding.bindingPath,
      "--cwd",
      root,
      "--",
      "node",
      "script.ts",
    ],
  });
  fs.writeFileSync(binding.bindingPath, JSON.stringify({ ...binding, owner: "other" }));
  expect(() => helper.readOwnedWorktree(root)).toThrow(/retained/i);
});
test("consumer marker alone never bypasses reacquisition; both actual inherited FDs are required", async () => {
  const helper = await load();
  const { binding } = fixture();
  expect(helper.hasOwnedConsumers(binding, { PHAROS_WORKTREE_CONSUMER: "job" })).toBe(false);
  const fd = fs.openSync(binding.bindingPath, "r");
  try {
    expect(
      helper.hasOwnedConsumers(binding, {
        PHAROS_WORKTREE_CONSUMER: "job",
        PHAROS_WORKTREE_LEASE_FD: String(fd),
        PHAROS_CACHE_LEASE_FD: "999999",
      }),
    ).toBe(false);
  } finally {
    fs.closeSync(fd);
  }
});
test("owned install is pinned to the manifest and explicit shared/local stores", async () => {
  const helper = await load();
  const { root, binding } = fixture();
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11.10.0" }),
  );
  expect(helper.ownedInstallArgs(binding, root)).toEqual([
    "pnpm",
    "install",
    "--frozen-lockfile",
    "--store-dir",
    path.join(binding.cachePayload, "pnpm"),
    "--virtual-store-dir",
    path.join(root, "node_modules/.pnpm"),
    "--manage-package-manager-versions",
  ]);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "npm@1" }));
  expect(() => helper.ownedInstallArgs(binding, root)).toThrow(/pnpm/);
});
