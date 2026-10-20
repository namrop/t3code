// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { afterEach, expect, test } from "vite-plus/test";

const fs = NodeFS;
const os = NodeOS;
const path = NodePath;
const childProcess = NodeChildProcess;

const dirs: string[] = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-worktree-"));
  dirs.push(root);
  const binding = {
    schemaVersion: 1 as const,
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

test("setup routes install and native warm through two-consumer prefixes without changing env links", () => {
  const { root, binding } = fixture();
  fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  for (const file of ["setup-worktree.ts", "lib/owned-worktree.ts"])
    fs.copyFileSync(path.join(import.meta.dirname, "..", file), path.join(root, "scripts", file));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module", packageManager: "pnpm@11.10.0" }),
  );
  fs.writeFileSync(path.join(root, ".pharos-owned-worktree.json"), JSON.stringify(binding));
  const log = path.join(root, "calls.jsonl");
  fs.writeFileSync(
    binding.producerCommand,
    `#!${process.execPath}\nimport * as fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(root, "vp"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
  const project = path.join(root, "main");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, ".env"), "FIXTURE=not-printed");
  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(root, "scripts/setup-worktree.ts")],
    {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, T3CODE_PROJECT_ROOT: project },
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const calls = fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("--frozen-lockfile");
  expect(calls[0]).toContain(path.join(binding.cachePayload, "pnpm"));
  expect(calls[1]).toContain(path.join(root, "apps/web/scripts/warm-dep-cache.ts"));
  expect(fs.readlinkSync(path.join(root, ".env"))).toBe(path.join(project, ".env"));
  expect(result.stdout).not.toContain("not-printed");
});

test("dev execs the native lifetime supervisor and preserves its nonzero exit", async () => {
  const helper = await load();
  expect(typeof helper.reexecOwnedDev).toBe("function");
  const { root, binding } = fixture();
  fs.writeFileSync(path.join(root, ".pharos-owned-worktree.json"), JSON.stringify(binding));
  fs.writeFileSync(binding.producerCommand, "#!/bin/sh\nexit 17\n", { mode: 0o755 });
  const script = path.join(root, "exec.mjs");
  fs.writeFileSync(
    script,
    `import { reexecOwnedDev } from ${JSON.stringify(path.join(import.meta.dirname, "owned-worktree.ts"))}; reexecOwnedDev(${JSON.stringify(root)}, ['node','dev-runner.ts','dev']); process.exit(99);`,
  );
  const result = childProcess.spawnSync(process.execPath, [script], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(17);
});
