#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const REPO = resolve(ROOT, "..");
const source = `${ROOT}/scripts/git-hooks/pre-push`;
const target = `${REPO}/.git/hooks/pre-push`;

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
chmodSync(target, 0o755);
console.log(`[hooks] installed ${target}`);
