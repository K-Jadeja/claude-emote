/**
 * Documentation commands are part of the user contract. This regression test
 * prevents renamed package scripts from leaving copyable README/docs commands
 * behind, as happened when overlay:update became overlay:setup.
 */

import { readFileSync, readdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..", "..");

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

describe("documented npm scripts", () => {
  it("references only scripts that exist in package.json", () => {
    const packageJson = JSON.parse(
      readFileSync(join(projectRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const knownScripts = new Set(Object.keys(packageJson.scripts));
    const docs = [
      join(projectRoot, "README.md"),
      ...markdownFiles(join(projectRoot, "docs")),
    ];
    const missing: string[] = [];

    for (const path of docs) {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/g)) {
        const script = match[1]!;
        if (!knownScripts.has(script)) {
          missing.push(`${path.slice(projectRoot.length + 1)}: ${script}`);
        }
      }
      for (const match of text.matchAll(
        /\bnode (?:\.?[\\/])?(scripts[\\/][a-zA-Z0-9._\\/-]+)/g,
      )) {
        const relativeScript = match[1]!.replaceAll("\\", "/");
        if (!existsSync(join(projectRoot, relativeScript))) {
          missing.push(
            `${path.slice(projectRoot.length + 1)}: ${relativeScript}`,
          );
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
