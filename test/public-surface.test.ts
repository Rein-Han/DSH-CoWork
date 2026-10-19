import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);

const ignoredDirectoryNames = new Set([".agents", ".git", ".worktrees", "dist", "node_modules", "release", "stage"]);
const ignoredFilePaths = new Set(["test/public-surface.test.ts"]);
const publicSurfaceRules = [
  ["drive-qualified user path", /[A-Za-z]:[\\/]+Users[\\/]+/i],
  ["AppData path segment", /(?:^|[\\/])AppData(?:[\\/]|$)/i],
  ["internal runner identity", new RegExp(["Codex", "SandboxOffline"].join(""))],
  ["maintenance backup reference", new RegExp(["refs", "/", "backup", "/"].join(""))],
  ["agent-only sub-skill directive", new RegExp(["REQUIRED", "\\s+", "SUB-SKILL"].join(""))],
  ["internal agent workflow marker", new RegExp(["super", "powers", ":"].join(""))],
] as const;

async function collectRepositoryFiles(directory: string, relativeDirectory = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || ignoredDirectoryNames.has(entry.name)) continue;

    const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectRepositoryFiles(absolutePath, relativePath)));
    } else if (entry.isFile() && !ignoredFilePaths.has(relativePath.replaceAll("\\", "/"))) {
      files.push(relativePath);
    }
  }
  return files;
}

test("public documentation identifies DSH-CoWork and credits its upstream", async () => {
  const [readme, overview, gitignore, validation] = await Promise.all([
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("docs/legacy/project-overview.md", root), "utf8"),
    readFile(new URL(".gitignore", root), "utf8"),
    readFile(new URL("docs/legacy/validation.md", root), "utf8"),
  ]);

  assert.match(readme, /^# DSH-CoWork$/m, "README must use the project title");
  assert.match(readme, /github\.com\/Fly2Kiana\/Codex-DSH-Orchestrator/, "README must credit the upstream repository");
  assert.match(readme, /dsh-Agentlink/, "README must credit dsh-Agentlink");
  assert.ok(readme.indexOf("## 安装") < readme.indexOf("## 使用"));
  assert.ok(readme.indexOf("## 使用") < readme.indexOf("## 卸载"));

  // Legacy upstream docs are kept for the RC6 adapter and stay free of machine data.
  assert.match(overview, /^# Codex-DSH-Orchestrator project overview$/m);
  assert.match(gitignore, /^\/\.agents\/skills\/codex-dsh-orchestrator\/$/m);
  assert.match(validation, /^# Validation guide$/m);
  assert.doesNotMatch(validation, /[A-Za-z]:[\\/]+Users[\\/]+/i);
  assert.doesNotMatch(validation, /refs[\\/]backup[\\/]/i);
});

test("public source snapshot preserves license, attribution, and compatibility metadata", async () => {
  const [manifest, license, notice] = await Promise.all([
    readFile(new URL("package.json", root), "utf8").then((raw) => JSON.parse(raw) as {
      name?: string;
      private?: boolean;
      license?: string;
      repository?: { url?: string };
      bin?: Record<string, string>;
    }),
    readFile(new URL("LICENSE", root), "utf8"),
    readFile(new URL("NOTICE", root), "utf8"),
  ]);

  assert.equal(manifest.private, true);
  assert.equal(manifest.name, "dsh-desktop-cowork");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.repository?.url, "https://github.com/Rein-Han/DSH-CoWork.git");
  // The private Desktop build renames its public commands; provenance, licence and
  // attribution assertions above are unchanged.
  assert.deepEqual(manifest.bin, {
    "dsh-desktop-cowork": "dist/index.js",
    "dsh-cowork-setup-desktop": "dist/setup-desktop.js",
    "dsh-cowork-doctor": "dist/doctor-desktop-cli.js",
    "dsh-cowork-verify-desktop": "dist/verify-desktop.js",
    "dsh-cowork-uninstall-desktop": "dist/uninstall-desktop.js",
    "dsh-cowork-legacy-doctor": "dist/doctor.js",
    "dsh-cowork-legacy-setup-codex": "dist/setup-codex.js",
    "dsh-cowork-legacy-setup-claude": "dist/setup-claude-code.js",
  });
  assert.match(license, /MIT License/);
  assert.match(notice, /dsh-Agentlink/);
  assert.match(notice, /Copyright/);
});

test("public source surface excludes machine-specific and internal maintenance data", async () => {
  const files = await collectRepositoryFiles(rootPath);

  for (const relativePath of files) {
    const document = await readFile(join(rootPath, relativePath), "utf8");
    for (const [label, rule] of publicSurfaceRules) {
      assert.doesNotMatch(document, rule, `${relativePath} contains ${label}`);
    }
  }
});

