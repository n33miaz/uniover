// Compila os esquemas (JSON Schema 2020-12), exige que todo exemplo válido passe
// e todo inválido falhe, e que o AsyncAPI cite todos os tipos.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Parser } from "@asyncapi/parser";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "agent");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const list = (d) => readdirSync(join(root, d)).filter((f) => f.endsWith(".json")).sort();

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

const envelope = read(join(root, "envelope.schema.json"));
ajv.addSchema(envelope);
const byType = new Map();
for (const f of list("messages")) {
  const schema = read(join(root, "messages", f));
  ajv.addSchema(schema);
  byType.set(f.replace(/\.schema\.json$/, ""), schema.$id);
}
const envelopeValidate = ajv.getSchema(envelope.$id);

let failures = 0;
const fail = (msg) => { failures++; console.error("FALHA: " + msg); };

// resultado: null = aceito; string = motivo da rejeição
function check(doc) {
  if (!envelopeValidate(doc)) return "envelope: " + ajv.errorsText(envelopeValidate.errors);
  const id = byType.get(doc.type);
  if (!id) return `type desconhecido: ${doc.type}`;
  const v = ajv.getSchema(id);
  return v(doc) ? null : `${doc.type}: ${ajv.errorsText(v.errors)}`;
}

for (const f of list("examples/valid")) {
  const doc = read(join(root, "examples/valid", f));
  const err = check(doc);
  if (err) fail(`exemplo válido rejeitado (${f}): ${err}`);
  if (f !== `${doc.type}.json`) fail(`nome do exemplo deve ser <type>.json (${f})`);
}
for (const t of byType.keys()) {
  if (!list("examples/valid").includes(`${t}.json`)) fail(`falta exemplo válido para ${t}`);
}
const invalid = list("examples/invalid");
if (invalid.length < 4) fail("são necessários ao menos 4 exemplos inválidos");
for (const f of invalid) {
  if (check(read(join(root, "examples/invalid", f))) === null) fail(`exemplo inválido aceito (${f})`);
}

const asyncapi = readFileSync(join(root, "asyncapi.yaml"), "utf8");
for (const t of byType.keys()) {
  if (!asyncapi.includes(`${t}.schema.json`)) fail(`asyncapi.yaml não cita ${t}`);
}

// Análise do documento AsyncAPI: qualquer diagnóstico de severidade erro reprova.
const parsed = await new Parser().parse(asyncapi, { source: join(root, "asyncapi.yaml") });
if (!parsed.document) fail("asyncapi.yaml não pôde ser analisado");
for (const d of parsed.diagnostics.filter((x) => x.severity === 0)) {
  fail(`asyncapi.yaml: ${d.code} ${d.message} (${d.path.join("/")})`);
}

if (failures) { console.error(`${failures} problema(s)`); process.exit(1); }
console.log(`ok: ${byType.size} esquemas, ${list("examples/valid").length} válidos, ${invalid.length} inválidos`);
