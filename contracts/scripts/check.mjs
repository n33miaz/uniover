// Gera tudo de novo numa pasta temporária e compara, byte a byte (após normalizar LF), com o que está
// versionado. Qualquer diferença (arquivo diferente, faltando ou sobrando) sai com código 1 e lista os arquivos.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  GENERATED_DIRS,
  GENERATED_PY_DIR,
  HAND_WRITTEN_PY,
  OPENAPI_FILE,
  REPO,
  generateAll,
} from "./generate.mjs";

const here = join(REPO, "contracts", "scripts");

// O `validate` vem antes: esquema ou exemplo inválido reprova sem gerar nada.
const validate = spawnSync(process.execPath, [join(here, "validate.mjs")], { stdio: "inherit" });
if (validate.status !== 0) process.exit(validate.status ?? 1);

const posix = (p) => p.split(sep).join("/");

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Arquivos que o gerador é dono, relativos à raiz informada. */
function owned(root) {
  const files = new Set([OPENAPI_FILE]);
  for (const d of GENERATED_DIRS) {
    for (const f of walk(join(root, d))) files.add(posix(relative(root, f)));
  }
  const py = join(root, GENERATED_PY_DIR);
  if (existsSync(py)) {
    for (const f of readdirSync(py)) {
      if (f.endsWith(".py") && !HAND_WRITTEN_PY.has(f)) files.add(`${GENERATED_PY_DIR}/${f}`);
    }
  }
  return files;
}

const read = (root, rel) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const tmp = mkdtempSync(join(tmpdir(), "uniover-contracts-"));
let problems = [];
try {
  await generateAll(tmp);
  const fresh = owned(tmp);
  const committed = owned(REPO);
  for (const rel of [...new Set([...fresh, ...committed])].sort()) {
    if (!committed.has(rel) || !existsSync(join(REPO, rel))) problems.push(`faltando no repositório: ${rel}`);
    else if (!fresh.has(rel)) problems.push(`sobrando (nenhuma fonte o gera): ${rel}`);
    else if (read(tmp, rel) !== read(REPO, rel)) problems.push(`diferente: ${rel}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (problems.length) {
  console.error("Os arquivos gerados não conferem com contracts/:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nCorrija com: npm --prefix contracts run generate (e inclua os arquivos gerados no commit)");
  process.exit(1);
}
console.log("ok: arquivos gerados conferem com contracts/");
