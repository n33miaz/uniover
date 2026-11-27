// Compara os arquivos gerados com os versionados, byte a byte após normalizar LF.
// Com --screen-python, gera somente os modelos Python do canal de tela, em memória.
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
  generateScreenPython,
} from "./generate.mjs";

const here = join(REPO, "contracts", "scripts");
const args = process.argv.slice(2);
const screenPython = args.length === 1 && args[0] === "--screen-python";
if (args.length && !screenPython) {
  console.error("Uso: npm --prefix contracts run check -- [--screen-python]");
  process.exit(1);
}

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

function ownedPython(root) {
  const dir = join(root, GENERATED_PY_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".py") && !HAND_WRITTEN_PY.has(f));
}

/** Arquivos que o gerador é dono, relativos à raiz informada. */
function owned(root) {
  const files = new Set([OPENAPI_FILE]);
  for (const d of GENERATED_DIRS) {
    for (const f of walk(join(root, d))) files.add(posix(relative(root, f)));
  }
  for (const f of ownedPython(root)) files.add(`${GENERATED_PY_DIR}/${f}`);
  return files;
}

const read = (root, rel) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

function compare(fresh, committed, readFresh) {
  const problems = [];
  for (const rel of [...new Set([...fresh, ...committed])].sort()) {
    if (!committed.has(rel) || !existsSync(join(REPO, rel))) problems.push(`faltando no repositório: ${rel}`);
    else if (!fresh.has(rel)) problems.push(`sobrando (nenhuma fonte o gera): ${rel}`);
    else if (readFresh(rel) !== read(REPO, rel)) problems.push(`diferente: ${rel}`);
  }
  return problems;
}

let problems;
if (screenPython) {
  const fresh = new Map(generateScreenPython());
  const committed = new Set(ownedPython(REPO)
    .filter((f) => f.startsWith("pc_screen_"))
    .map((f) => `${GENERATED_PY_DIR}/${f}`));
  problems = compare(new Set(fresh.keys()), committed, (rel) => fresh.get(rel));
} else {
  const tmp = mkdtempSync(join(tmpdir(), "uniover-contracts-"));
  try {
    await generateAll(tmp);
    problems = compare(owned(tmp), owned(REPO), (rel) => read(tmp, rel));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (problems.length) {
  console.error("Os arquivos gerados não conferem com contracts/:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nCorrija com: npm --prefix contracts run generate (e inclua os arquivos gerados no commit)");
  process.exit(1);
}
console.log("ok: arquivos gerados conferem com contracts/");
