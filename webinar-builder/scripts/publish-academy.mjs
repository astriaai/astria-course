#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import "dotenv/config";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const REPO = resolve(ROOT, "..");

const args = new Set(process.argv.slice(2));
const forceLocal = args.has("--local");
const forceGithub = args.has("--github");
const skipBuild = args.has("--skip-build");
const skipDeploy = args.has("--no-deploy");
const prePush = args.has("--pre-push");
const watch = args.has("--watch");

const REQUIRED_LOCAL_KEYS = ["VERTEX_API_KEY", "WAVESPEED_API_KEY"];
const OPTIONAL_LOCAL_KEYS = [
  "HEYGEN_API_KEY",
  "BYTEPLUS_ACCESS_KEY_ID",
  "BYTEPLUS_SECRET_ACCESS_KEY",
  "REPLICATE_API_KEY",
  "ASTRIA_AUTH_TOKEN",
  "GEMINI_TUNE_ID",
  "WORKSPACE_ID",
  "ASTRIA_BASE_URL",
];

function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf-8",
  });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture
      ? `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      : "";
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed with ${result.status}${detail}`);
  }
  return result;
}

function commandExists(cmd) {
  return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
}

function currentSha() {
  return run("git", ["rev-parse", "HEAD"], { cwd: REPO, capture: true }).stdout.trim();
}

function localKeysAvailable() {
  return REQUIRED_LOCAL_KEYS.every((key) => !!process.env[key]);
}

function missingKeys() {
  return [...REQUIRED_LOCAL_KEYS, ...OPTIONAL_LOCAL_KEYS].filter((key) => !process.env[key]);
}

function projects() {
  return readdirSync(`${ROOT}/script/projects`)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => basename(file, ".yaml"))
    .sort();
}

function triggerGithubPublish() {
  if (!commandExists("gh")) {
    throw new Error("GitHub fallback requires the `gh` CLI. Push to main or install/authenticate gh.");
  }
  console.log("[publish-academy] triggering GitHub workflow: Publish course");
  run("gh", ["workflow", "run", "publish.yml", "--ref", "main"], { cwd: REPO });
  run("gh", ["run", "list", "--workflow", "Publish course", "--limit", "3"], { cwd: REPO });
  if (watch) {
    const latest = run("gh", ["run", "list", "--workflow", "Publish course", "--limit", "1", "--json", "databaseId", "-q", ".[0].databaseId"], {
      cwd: REPO,
      capture: true,
    }).stdout.trim();
    if (latest) run("gh", ["run", "watch", latest, "--exit-status"], { cwd: REPO });
  }
}

function triggerPagesDeploy() {
  if (skipDeploy) return;
  if (!commandExists("gh")) {
    console.warn("[publish-academy] `gh` not found; run Actions > Deploy Pages site manually.");
    return;
  }
  console.log("[publish-academy] triggering GitHub Pages redeploy");
  run("gh", ["workflow", "run", "pages-deploy.yml", "--ref", "main"], { cwd: REPO });
  if (watch) {
    const latest = run("gh", ["run", "list", "--workflow", "Deploy Pages site", "--limit", "1", "--json", "databaseId", "-q", ".[0].databaseId"], {
      cwd: REPO,
      capture: true,
    }).stdout.trim();
    if (latest) run("gh", ["run", "watch", latest, "--exit-status"], { cwd: REPO });
  }
}

function localPublish() {
  const absent = missingKeys();
  if (absent.length > 0) {
    console.warn(`[publish-academy] missing local key(s): ${absent.join(", ")}`);
  }
  run("npm", ["run", "ci:restore"]);

  if (!skipBuild) {
    const env = {
      ...process.env,
      HF_WORKERS: process.env.HF_WORKERS ?? "1",
      NO_SCREENCAST: process.env.NO_SCREENCAST ?? "1",
    };
    for (const project of projects()) {
      console.log(`[publish-academy] building ${project}`);
      run("npx", ["tsx", "pipeline/build.ts", "--project", project, "--all", "--parallel", "1"], { env });
      run("npx", ["tsx", "pipeline/stitch.ts", "--project", project], { env, allowFailure: true });
    }
  }

  const dashboardEnv = {
    ...process.env,
    BUILD_MODE: "main",
    GIT_SHA: currentSha(),
    PAGES_BASE_URL: process.env.PAGES_BASE_URL ?? "https://astriaai.github.io/academy",
  };
  run("npm", ["run", "dashboard"], { env: dashboardEnv });
  run("npm", ["run", "ci:publish", "--", "root"]);
  triggerPagesDeploy();
}

try {
  if (forceGithub || (!forceLocal && !localKeysAvailable())) {
    if (prePush) {
      console.warn("[publish-academy] local API keys are missing; allowing push so GitHub Actions can build and publish from main.");
      process.exit(0);
    }
    if (forceLocal) {
      throw new Error("Cannot force local publish: required local API keys are missing.");
    }
    triggerGithubPublish();
  } else {
    localPublish();
  }
} catch (error) {
  console.error(`[publish-academy] ${error.message}`);
  process.exit(1);
}
