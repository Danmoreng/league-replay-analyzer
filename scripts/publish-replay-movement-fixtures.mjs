import { access, cp, mkdir, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join } from "node:path";

const sourceDir = resolve("artifacts");
const targetDir = resolve("apps", "web", "public", "replay-movement-fixtures");
const replayDirPattern = /^[A-Z0-9]+-\d+$/;
const publishedFiles = [
  "participant-movement.json",
  "assigned-movement-validation-report.json",
];

async function pathExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  const entries = await readdir(sourceDir, { withFileTypes: true });
  let publishedReplayCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || !replayDirPattern.test(entry.name)) {
      continue;
    }

    const sourceReplayDir = join(sourceDir, entry.name);
    const targetReplayDir = join(targetDir, entry.name.replace(/-/g, "_"));
    let copiedAny = false;

    for (const fileName of publishedFiles) {
      const sourcePath = join(sourceReplayDir, fileName);
      if (!(await pathExists(sourcePath))) {
        continue;
      }

      if (!copiedAny) {
        await mkdir(targetReplayDir, { recursive: true });
        copiedAny = true;
      }

      await cp(sourcePath, join(targetReplayDir, fileName), { force: true });
    }

    if (copiedAny) {
      publishedReplayCount += 1;
    }
  }

  console.log(`Published replay movement fixtures for ${publishedReplayCount} replays to ${targetDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
