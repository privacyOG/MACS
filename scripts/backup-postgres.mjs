import { createGzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const backupDir = path.join(rootDir, "data", "backups");
const containerName = process.env.POSTGRES_CONTAINER_NAME || "lawnquote-postgres";
const databaseName = process.env.POSTGRES_DB || "lawnquote";
const databaseUser = process.env.POSTGRES_USER || "lawnquote";
const maxBackups = Number(process.env.POSTGRES_BACKUP_KEEP || 30);

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  await mkdir(backupDir, { recursive: true });
  const outputPath = path.join(backupDir, `postgres-${timestamp()}.sql.gz`);
  const dump = spawn("docker", ["exec", containerName, "pg_dump", "-U", databaseUser, "-d", databaseName], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const gzip = createGzip({ level: 9 });
  const output = createWriteStream(outputPath, { mode: 0o600 });
  let errorText = "";
  dump.stderr.on("data", (chunk) => {
    errorText += chunk.toString("utf8");
  });
  dump.stdout.pipe(gzip).pipe(output);
  const code = await new Promise((resolve) => dump.on("close", resolve));
  if (code !== 0) {
    throw new Error(errorText.trim() || `pg_dump failed with exit code ${code}`);
  }
  await new Promise((resolve, reject) => {
    output.on("finish", resolve);
    output.on("error", reject);
  });
  const backups = (await readdir(backupDir))
    .filter((name) => /^postgres-.*\.sql\.gz$/.test(name))
    .map((name) => path.join(backupDir, name));
  const byModified = [];
  for (const filePath of backups) {
    const fileStat = await stat(filePath).catch(() => null);
    if (fileStat) byModified.push({ filePath, mtimeMs: fileStat.mtimeMs });
  }
  byModified.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const oldBackup of byModified.slice(Number.isFinite(maxBackups) && maxBackups > 0 ? maxBackups : 30)) {
    await unlink(oldBackup.filePath).catch(() => {});
  }
  console.log(`PostgreSQL backup written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
