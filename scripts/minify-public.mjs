import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { minify } from "terser";

const publicDir = path.resolve(new URL("../public", import.meta.url).pathname);
const files = await readdir(publicDir);

let count = 0;
for (const file of files) {
  if (!file.endsWith(".js")) continue;
  const filePath = path.join(publicDir, file);
  const source = await readFile(filePath, "utf8");

  // Skip already-minified files (no newlines or very short lines)
  const avgLineLen = source.length / Math.max(1, source.split("\n").length);
  if (avgLineLen > 500) {
    console.log(`⏭️  ${file}: already minified, skipping`);
    continue;
  }

  try {
    const result = await minify(source, {
      sourceMap: false,
      compress: { drop_console: false },
      mangle: true,
      output: { comments: false },
      ecma: 2020,
      module: true
    });

    if (result.code) {
      await writeFile(`${filePath}.orig`, source);
      await writeFile(filePath, result.code);
      const reduction = Math.round((1 - result.code.length / source.length) * 100);
      console.log(`✅ ${file}: ${source.length} → ${result.code.length} bytes (${reduction}% smaller)`);
      count++;
    }
  } catch (err) {
    console.error(`❌ Failed to minify ${file}: ${err.message}`);
  }
}

console.log(`\nMinified ${count} files. Originals backed up as .orig`);
