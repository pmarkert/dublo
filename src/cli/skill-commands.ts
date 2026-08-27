import { cp, mkdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

const SKILL_NAME = "dublo";

interface SkillInstallOptions {
  target?: string;
  user?: boolean;
  force?: boolean;
}

// Walk up from this module until a package.json is found. Works both from the
// compiled dist/ tree and from a source (tsx) checkout.
function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Could not locate the dublo package root.");
    dir = parent;
  }
}

// The skill is authored under .claude/skills (used by this repo's own agents)
// and copied into resources/skills at build/pack time so it ships in the npm
// package. Prefer the packaged copy; fall back to the source for dev checkouts.
export function resolveBundledSkillDir(): string {
  const root = findPackageRoot();
  const candidates = [
    path.join(root, "resources", "skills", SKILL_NAME),
    path.join(root, ".claude", "skills", SKILL_NAME)
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "SKILL.md"))) return candidate;
  }
  throw new Error(
    "Bundled dublo skill not found. Reinstall dublo, or run `npm run build` in a source checkout."
  );
}

function packageVersion(): string {
  try {
    const raw = readFileSync(path.join(findPackageRoot(), "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string") return version;
    }
  } catch {
    // fall through
  }
  return "unknown";
}

/** Returns the bundled SKILL.md text. */
export async function readSkillDoc(): Promise<string> {
  return readFile(path.join(resolveBundledSkillDir(), "SKILL.md"), "utf8");
}

/**
 * Copies the bundled skill into `<skillsDir>/dublo`. Refuses to overwrite an
 * existing install unless `force` is set, so a hand-edited copy is never
 * clobbered silently; re-run with force to update after upgrading dublo.
 */
export async function installSkill(
  skillsDir: string,
  options: { force?: boolean } = {}
): Promise<{ destination: string; version: string }> {
  const source = resolveBundledSkillDir();
  const destination = path.join(skillsDir, SKILL_NAME);
  if (existsSync(destination) && !options.force) {
    throw new Error(
      `A dublo skill is already installed at '${destination}'. Re-run with --force to overwrite (for example after upgrading dublo).`
    );
  }
  await mkdir(skillsDir, { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
  return { destination, version: packageVersion() };
}

function resolveSkillsDir(options: SkillInstallOptions): string {
  if (options.user) return path.join(os.homedir(), ".claude", "skills");
  if (options.target) return path.resolve(process.cwd(), options.target);
  return path.join(process.cwd(), ".claude", "skills");
}

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command("skill")
    .description("Install or print the bundled Dublo agent skill");

  skill
    .command("install")
    .description("Copy the bundled Dublo skill into a Claude Code skills directory")
    .option("--target <dir>", "Skills directory to install into (default: ./.claude/skills)")
    .option("--user", "Install into ~/.claude/skills instead of the current project")
    .option("--force", "Overwrite an existing installed skill (e.g. after upgrading dublo)")
    .action(async (options: SkillInstallOptions) => {
      const skillsDir = resolveSkillsDir(options);
      const { destination, version } = await installSkill(skillsDir, {
        force: Boolean(options.force)
      });
      process.stdout.write(`Installed the dublo skill (v${version}) to ${destination}\n`);
      process.stdout.write("Claude Code will pick it up on its next session in that directory.\n");
    });

  skill
    .command("show")
    .description("Print the bundled Dublo SKILL.md to stdout")
    .action(async () => {
      process.stdout.write(await readSkillDoc());
    });
}
