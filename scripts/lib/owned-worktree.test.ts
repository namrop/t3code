// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off globalTimers:off - native process fixture deadlines outside Effect.
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

// Opt-in native regression: no substitute backing check or fake producer.
test.skipIf(!process.env.PHAROS_TEST_PRODUCER)(
  "packaged producer supervises the actual dev entry and Effect children",
  async () => {
    const producer = fs.realpathSync(process.env.PHAROS_TEST_PRODUCER!);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-dev-chain-"));
    dirs.push(root);
    const exec = (command: string, args: string[]) => {
      const result = childProcess.spawnSync(command, args, { encoding: "utf8", cwd: root });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout;
    };
    const mount = JSON.parse(
      exec("findmnt", ["--json", "--target", root, "--output", "TARGET,SOURCE,FSTYPE,FSROOT"]),
    ).filesystems[0];
    const backing = {
      mountPoint: mount.target,
      device: mount.source.split("[")[0],
      fsType: mount.fstype,
      fsRoot: mount.fsroot,
    };
    for (const name of ["work", "cache", "records", "retained", "repo"])
      fs.mkdirSync(path.join(root, name));
    const home = (name: string) => ({
      path: path.join(root, name),
      backing,
      lifecycle: {
        ownerRelease: {
          owner: "test-dev-chain",
          recordRoot: path.join(root, "records"),
          retainedRoot: path.join(root, "retained"),
        },
      },
    });
    const manifest = path.join(root, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ schemaVersion: 1, homes: { work: home("work"), cache: home("cache") } }),
    );
    const repo = path.join(root, "repo");
    exec("git", ["-C", repo, "init", "-q"]);
    fs.writeFileSync(path.join(repo, "tracked"), "tiny dev-chain fixture\n");
    exec("git", ["-C", repo, "add", "tracked"]);
    exec("git", [
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--only",
      "-qm",
      "fixture",
      "--",
      "tracked",
    ]);
    const created = JSON.parse(
      exec(producer, [
        "--manifest",
        manifest,
        "--home",
        "work",
        "create-worktree",
        "--owner",
        "test-dev-chain",
        "--cache-home",
        "cache",
        "--published-root",
        path.join(root, "work"),
        "--producer-command",
        producer,
        "--repo",
        repo,
        "--ref",
        "HEAD",
        "--new-branch",
        "fixture-dev",
      ]),
    );
    const worktree = created.worktreePath;
    fs.mkdirSync(path.join(worktree, "scripts/lib"), { recursive: true });
    for (const file of [
      "dev-runner.ts",
      "lib/owned-worktree.ts",
      "lib/public-config.ts",
      "lib/dev-share.ts",
    ])
      fs.copyFileSync(
        path.join(import.meta.dirname, "..", file),
        path.join(worktree, "scripts", file),
      );
    fs.symlinkSync(
      path.join(import.meta.dirname, "../node_modules"),
      path.join(worktree, "scripts/node_modules"),
    );
    fs.writeFileSync(path.join(worktree, "package.json"), '{"type":"module"}');
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const identity = `const identity = () => { const s = fs.readFileSync('/proc/self/stat','utf8').split(' '); return {pid:process.pid,ppid:process.ppid,pgid:Number(s[4])}; };`;
    const leaf = path.join(worktree, "scripts/leaf.mjs");
    fs.writeFileSync(
      leaf,
      `import fs from 'node:fs'; import net from 'node:net'; ${identity} const server=net.createServer(); server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.env.PROOF+'.leaf',JSON.stringify({...identity(),port:server.address().port})));`,
    );
    const vp = path.join(worktree, "scripts/fixture-vp.mjs");
    fs.writeFileSync(
      vp,
      `import fs from 'node:fs'; import * as Effect from 'effect/Effect'; import * as NodeServices from '@effect/platform-node/NodeServices'; import * as NodeRuntime from '@effect/platform-node/NodeRuntime'; import {ChildProcess} from 'effect/process'; ${identity} fs.writeFileSync(process.env.PROOF+'.vp',JSON.stringify(identity())); Effect.gen(function*(){ yield* ChildProcess.make(process.execPath,[${JSON.stringify(leaf)}],{stdout:'inherit',stderr:'inherit'}); while(!fs.existsSync(process.env.PROOF+'.stop')) yield* Effect.sleep('20 millis'); if(process.env.CASE==='error') yield* Effect.die('fixture-error'); }).pipe(Effect.scoped,Effect.provide(NodeServices.layer),NodeRuntime.runMain);`,
    );
    fs.writeFileSync(
      path.join(bin, "vp"),
      `#!${process.execPath}\nimport {spawn} from 'node:child_process'; const c=spawn(process.execPath,['--conditions=development',${JSON.stringify(vp)}],{stdio:'inherit'}); c.on('exit',code=>process.exit(code??1)); process.on('SIGTERM',()=>c.kill('SIGTERM')); process.on('SIGINT',()=>c.kill('SIGINT'));`,
      { mode: 0o755 },
    );
    const waitFor = async (condition: () => boolean, label: string) => {
      const end = Date.now() + 10000;
      while (!condition() && Date.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(condition(), label).toBe(true);
    };
    const live = (pid: number) => {
      try {
        return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] !== "Z";
      } catch {
        return false;
      }
    };
    const signalGroup = (pid: number, signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch {}
    };
    const receipts: unknown[] = [];
    for (const mode of [
      "normal",
      "error",
      "SIGINT",
      "SIGTERM",
      "supervisor-loss",
      "runner-crash",
    ]) {
      const proof = path.join(root, mode);
      const log = fs.openSync(proof + ".log", "w");
      const wrapper = childProcess.spawn(
        process.execPath,
        [
          "--conditions=development",
          path.join(worktree, "scripts/dev-runner.ts"),
          "dev:server",
          "--host",
          "127.0.0.1",
        ],
        {
          cwd: worktree,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CASE: mode, PROOF: proof },
          stdio: ["ignore", log, log],
        },
      );
      fs.closeSync(log);
      let runner = 0,
        leafPid = 0,
        leafGroup = 0;
      try {
        await waitFor(
          () => fs.existsSync(proof + ".leaf"),
          fs.readFileSync(proof + ".log", "utf8"),
        );
        const vpInfo = JSON.parse(fs.readFileSync(proof + ".vp", "utf8"));
        const leafInfo = JSON.parse(fs.readFileSync(proof + ".leaf", "utf8"));
        // fixture shell -> Effect VP -> detached leaf; discover runner from the captured shell parent.
        const shellPid = vpInfo.ppid;
        runner = Number(fs.readFileSync(`/proc/${shellPid}/stat`, "utf8").split(" ")[3]);
        leafPid = leafInfo.pid;
        leafGroup = leafInfo.pgid;
        const env = Object.fromEntries(
          fs
            .readFileSync(`/proc/${runner}/environ`, "utf8")
            .split("\0")
            .map((line) => line.split(/=(.*)/s).slice(0, 2)),
        );
        const fdPaths = [env.PHAROS_WORKTREE_LEASE_FD, env.PHAROS_CACHE_LEASE_FD].map(
          (fd) => `/proc/${runner}/fd/${fd}`,
        );
        expect(fdPaths.every((fd) => fs.statSync(fd).isFile())).toBe(true);
        expect(fs.statSync(fdPaths[0]!).ino).not.toBe(fs.statSync(fdPaths[1]!).ino);
        const runnerGroup = Number(fs.readFileSync(`/proc/${runner}/stat`, "utf8").split(" ")[4]);
        expect(runnerGroup).toBe(runner);
        expect(fs.readFileSync(`/proc/${wrapper.pid}/cmdline`, "utf8")).toContain(
          "pharos-work-producer",
        );
        const receipt = {
          mode,
          producer,
          wrapper: wrapper.pid,
          runner,
          runnerGroup,
          vp: vpInfo,
          leaf: leafInfo,
          fdPaths,
          inheritedFiles: fdPaths.map((fd) => fs.readlinkSync(fd)),
          stopped: false,
          returncode: null as number | null,
          signal: null as string | null,
        };
        receipts.push(receipt);
        if (mode === "runner-crash") process.kill(runner, "SIGKILL");
        else if (mode === "supervisor-loss") {
          wrapper.kill("SIGKILL");
          await waitFor(() => wrapper.signalCode === "SIGKILL", "supervisor exit");
          expect(live(runner)).toBe(true);
          expect(fdPaths.every((fd) => fs.statSync(fd).isFile())).toBe(true);
          signalGroup(runner, "SIGTERM");
        } else if (mode === "SIGINT" || mode === "SIGTERM") wrapper.kill(mode);
        else fs.writeFileSync(proof + ".stop", "stop");
        await waitFor(
          () => !live(runner) && !live(leafPid),
          `${mode}: direct runner and detached Effect leaf must stop`,
        );
        if (mode !== "supervisor-loss")
          await waitFor(
            () => wrapper.exitCode !== null || wrapper.signalCode !== null,
            "producer exit",
          );
        receipt.stopped = true;
        receipt.returncode = wrapper.exitCode;
        receipt.signal = wrapper.signalCode;
        if (mode === "normal") expect(wrapper.exitCode).toBe(0);
        if (mode === "error") expect(wrapper.exitCode).not.toBe(0);
      } finally {
        if (runner) signalGroup(runner, "SIGKILL");
        if (leafGroup) signalGroup(leafGroup, "SIGKILL");
        if (wrapper.exitCode === null && wrapper.signalCode === null) {
          wrapper.kill("SIGKILL");
          await new Promise((resolve) => wrapper.once("close", resolve));
        }
        if (process.env.PHAROS_TEST_PROOF_DIR) {
          fs.mkdirSync(process.env.PHAROS_TEST_PROOF_DIR, { recursive: true });
          fs.writeFileSync(
            path.join(process.env.PHAROS_TEST_PROOF_DIR, "native-dev-receipts.json"),
            JSON.stringify({ producer, backing, binding: created.binding, receipts }, null, 2),
          );
          fs.copyFileSync(
            proof + ".log",
            path.join(process.env.PHAROS_TEST_PROOF_DIR, `${mode}.log`),
          );
        }
      }
    }
  },
  90000,
);
