// Gera, a partir de contracts/, tudo que as três linguagens consomem:
//   (a) contracts/http/openapi.json            (build da API, via teste de integração sem banco)
//   (b) tipos C# e constantes dos `type`       (apps/api/.../AgentProtocol/Generated)
//   (c) modelos pydantic e cópias dos esquemas (apps/agent/src/uniover_agent/contracts)
//   (d) tipos TypeScript do HTTP               (apps/web/src/app/core/api/generated/schema.ts)
//   (e) tipos TypeScript das mensagens         (apps/web/src/app/core/api/generated/agent)
// Uso: `npm --prefix contracts run generate`. O `check.mjs` reaproveita `generateAll` numa pasta temporária.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "json-schema-to-typescript";
import openapiTS, { astToString } from "openapi-typescript";
import { format } from "prettier";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRACTS = join(REPO, "contracts");
const AGENT_SCHEMAS = join(CONTRACTS, "agent");

/** Pastas (relativas à raiz do repositório) cujo conteúdo é inteiramente gerado, e arquivos gerados soltos. */
export const GENERATED_DIRS = [
  "apps/api/src/UniOver.BuildingBlocks.AgentProtocol/Generated",
  "apps/agent/src/uniover_agent/contracts/schemas",
  "apps/web/src/app/core/api/generated",
];
export const GENERATED_PY_DIR = "apps/agent/src/uniover_agent/contracts";
/** O `__init__.py` do agente é escrito à mão; nada mais solto nesta pasta é. */
export const HAND_WRITTEN_PY = new Set(["__init__.py"]);
export const OPENAPI_FILE = "contracts/http/openapi.json";

const CSHARP_NAMESPACE = "UniOver.BuildingBlocks.AgentProtocol.Generated";
const COMMAND = "npm --prefix contracts run generate";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const lf = (text) => text.replace(/\r\n/g, "\n");
const withFinalNewline = (text) => (text.endsWith("\n") ? text : text + "\n");

function write(out, rel, text) {
  const file = join(out, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, withFinalNewline(lf(text)), "utf8");
}

const pascal = (s) => s.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c) => c.toUpperCase());
const snake = (s) => s.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();

// ---------------------------------------------------------------------------------------------------------
// Entrada: esquemas do agente, já "achatados" (sem $ref para outros arquivos) para os geradores
// ---------------------------------------------------------------------------------------------------------

export function loadSchemas() {
  const envelope = readJson(join(AGENT_SCHEMAS, "envelope.schema.json"));
  const messages = readdirSync(join(AGENT_SCHEMAS, "messages"))
    .filter((f) => f.endsWith(".schema.json"))
    .sort()
    .map((f) => {
      const schema = readJson(join(AGENT_SCHEMAS, "messages", f));
      const type = f.replace(/\.schema\.json$/, "");
      return { file: f, type, schema };
    });
  return { envelope, messages };
}

/** Troca `$ref` para `envelope.schema.json#/$defs/x` (ou `#/$defs/x`) pelo conteúdo, recursivamente. */
function inlineRefs(node, defs) {
  if (Array.isArray(node)) return node.map((n) => inlineRefs(n, defs));
  if (node && typeof node === "object") {
    if (typeof node.$ref === "string") {
      const m = /(?:^|\.schema\.json)#\/\$defs\/([A-Za-z0-9_]+)$/.exec(node.$ref);
      if (!m || !defs[m[1]]) throw new Error(`$ref não resolvida: ${node.$ref}`);
      return inlineRefs(structuredClone(defs[m[1]]), defs);
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, inlineRefs(v, defs)]));
  }
  return node;
}

/** Dá nome (title) a todo objeto e enum aninhado, para que os tipos gerados não colidam entre mensagens. */
function nameNested(schema, prefix) {
  const visit = (node, name) => {
    if (!node || typeof node !== "object") return;
    const isObject = node.type === "object";
    const isEnum = Array.isArray(node.enum);
    if ((isObject || isEnum) && !node.title) node.title = name;
    for (const [prop, child] of Object.entries(node.properties ?? {})) {
      visit(child, name + pascal(prop));
    }
    if (node.items) visit(node.items, name + "Item");
  };
  for (const [prop, child] of Object.entries(schema.properties ?? {})) {
    visit(child, prefix + pascal(prop));
  }
}

/** Remove palavras-chave que os geradores de tipos não modelam (a validação fica com o JSON Schema). */
function stripValidationOnly(node) {
  if (Array.isArray(node)) return node.forEach(stripValidationOnly);
  if (node && typeof node === "object") {
    for (const k of ["if", "then", "else", "$schema", "$id", "$defs"]) delete node[k];
    Object.values(node).forEach(stripValidationOnly);
  }
}

/** Troca `const` por um tipo simples (o C# gerado não precisa de um enum de um valor só). */
function constToType(node) {
  if (Array.isArray(node)) return node.forEach(constToType);
  if (node && typeof node === "object") {
    if ("const" in node) {
      node.type = typeof node.const === "number" ? "integer" : typeof node.const;
      delete node.const;
    }
    Object.values(node).forEach(constToType);
  }
}

export function flatten({ envelope, messages }) {
  const defs = envelope.$defs;
  const flatEnvelope = structuredClone(envelope);
  flatEnvelope.title = "Envelope";
  flatEnvelope.properties = inlineRefs(flatEnvelope.properties, defs);
  // O corpo do envelope é livre (cada `type` define o seu): mapa aberto em vez de objeto vazio.
  if (flatEnvelope.properties.body?.type === "object") flatEnvelope.properties.body.additionalProperties = true;
  stripValidationOnly(flatEnvelope);

  const flatMessages = messages.map(({ type, schema }) => {
    const name = pascal(type);
    const flat = inlineRefs(structuredClone(schema), defs);
    flat.title = `${name}Message`;
    if (flat.properties?.body) flat.properties.body.title = `${name}Body`;
    nameNested(flat.properties.body ?? {}, `${name}Body`);
    stripValidationOnly(flat);
    return { type, name, schema: flat };
  });
  return { flatEnvelope, flatMessages };
}

// ---------------------------------------------------------------------------------------------------------
// Execução de ferramentas externas
// ---------------------------------------------------------------------------------------------------------

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} falhou (${r.status})\n${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  }
  return r.stdout;
}

const QUICKTYPE = join(CONTRACTS, "node_modules", "quicktype", "dist", "index.js");
const DATAMODEL_CODEGEN = "datamodel-code-generator==0.86.0";

// ---------------------------------------------------------------------------------------------------------
// (a) OpenAPI
// ---------------------------------------------------------------------------------------------------------

function generateOpenApi(out) {
  const target = join(out, OPENAPI_FILE);
  mkdirSync(dirname(target), { recursive: true });
  run(
    "dotnet",
    [
      "test",
      "--project",
      "tests/UniOver.IntegrationTests",
      "--filter-class",
      "*OpenApiContractTests",
    ],
    { cwd: join(REPO, "apps", "api"), env: { ...process.env, UNIOVER_OPENAPI_OUTPUT: target } },
  );
  if (!existsSync(target)) throw new Error("A API não gravou o openapi.json.");
}

// ---------------------------------------------------------------------------------------------------------
// (b) C#
// ---------------------------------------------------------------------------------------------------------

const CSHARP_HEADER = `// GERADO por \`${COMMAND}\` — não editar.`;

function quicktypeCsharp(tmp, name, schema) {
  const input = join(tmp, `${name}.json`);
  writeFileSync(input, JSON.stringify(schema, null, 2), "utf8");
  const raw = lf(
    run(process.execPath, [
      QUICKTYPE,
      "--src-lang", "schema",
      "--lang", "csharp",
      "--framework", "SystemTextJson",
      "--namespace", CSHARP_NAMESPACE,
      "--csharp-version", "8",
      "--any-type", "object",
      "--number-type", "double",
      "--no-dateonly-timeonly-converters",
      "--top-level", name,
      input,
    ]),
  );
  // Cada arquivo tem os seus auxiliares; o prefixo evita colisão no mesmo namespace.
  const internals = [...raw.matchAll(/^\s*internal (?:static )?class (\w+)/gm)].map((m) => m[1]);
  const helpers = [...new Set(["Serialize", ...internals])];
  let code = raw;
  // Só o nome solto (ou qualificado pelo namespace): `JsonSerializer.Serialize` não pode ser tocado.
  for (const h of helpers) {
    code = code.replace(new RegExp(`(?<![\\w.])${h}\\b|(?<=Generated\\.)${h}\\b`, "g"), `${name}${h}`);
  }
  // Remove o comentário de instruções de uso que a ferramenta coloca no topo.
  code = code.replace(/^\/\/ <auto-generated \/>\n\/\/\n[\s\S]*?\n(?=#nullable)/, "// <auto-generated />\n");
  return `${CSHARP_HEADER}\n${code.trimEnd()}\n`;
}

function generateCsharp(out, flat, messages) {
  const dir = "apps/api/src/UniOver.BuildingBlocks.AgentProtocol/Generated";
  const tmp = join(out, ".tmp-quicktype");
  mkdirSync(tmp, { recursive: true });

  const types = [{ type: "envelope", name: "Envelope", schema: flat.flatEnvelope }, ...flat.flatMessages.map((m) => ({ type: m.type, name: `${m.name}Message`, schema: m.schema }))];
  for (const t of types) {
    const schema = structuredClone(t.schema);
    constToType(schema);
    write(out, `${dir}/${t.name}.cs`, quicktypeCsharp(tmp, t.name, schema));
  }
  rmSync(tmp, { recursive: true, force: true });

  // Constantes dos `type`, a partir da lista de esquemas.
  const constants = messages
    .map((m) => `    /// <summary>Tipo de mensagem <c>${m.type}</c>.</summary>\n    public const string ${pascal(m.type)} = "${m.type}";`)
    .join("\n\n");
  const all = messages.map((m) => `        ${pascal(m.type)},`).join("\n");
  write(
    out,
    `${dir}/AgentMessageTypes.cs`,
    `${CSHARP_HEADER}
// <auto-generated />
#nullable enable

namespace ${CSHARP_NAMESPACE};

/// <summary>Valores do campo <c>type</c> das mensagens entre a API e o agente.</summary>
public static class AgentMessageTypes
{
${constants}

    /// <summary>Todos os tipos conhecidos, em ordem alfabética.</summary>
    public static readonly IReadOnlyList<string> All =
    [
${all}
    ];
}
`,
  );

  // Fora da pasta gerada, o estilo e os analisadores do projeto continuam valendo; aqui dentro não se aplica.
  write(
    out,
    `${dir}/.editorconfig`,
    `# GERADO por \`${COMMAND}\` — não editar.
[*.cs]
generated_code = true
dotnet_analyzer_diagnostic.severity = none
dotnet_diagnostic.CS8618.severity = none
dotnet_diagnostic.CS8601.severity = none
dotnet_diagnostic.CS8602.severity = none
dotnet_diagnostic.CS8603.severity = none
`,
  );
}

// ---------------------------------------------------------------------------------------------------------
// (c) Python
// ---------------------------------------------------------------------------------------------------------

const PY_HEADER = `# GERADO por \`${COMMAND}\` — não editar.\n# ruff: noqa\n# fmt: off`;

/** O pydantic converte `date-time` em datetime e não aplica `pattern` a ele; a exigência do "Z" fica no JSON Schema. */
function dropPatternOnDates(node) {
  if (Array.isArray(node)) return node.forEach(dropPatternOnDates);
  if (node && typeof node === "object") {
    if (node.format === "date-time") delete node.pattern;
    Object.values(node).forEach(dropPatternOnDates);
  }
}

function generatePython(out, flat, schemasMeta) {
  const dir = GENERATED_PY_DIR;
  const tmp = join(out, ".tmp-py");
  mkdirSync(tmp, { recursive: true });

  const items = [
    { module: "envelope", cls: "Envelope", schema: flat.flatEnvelope },
    ...flat.flatMessages.map((m) => ({ module: snake(m.type), cls: `${m.name}Message`, schema: m.schema, type: m.type })),
  ];
  for (const it of items) {
    const input = join(tmp, `${it.module}.schema.json`);
    const schema = structuredClone(it.schema);
    dropPatternOnDates(schema);
    writeFileSync(input, JSON.stringify(schema, null, 2), "utf8");
    const output = join(tmp, `${it.module}.py`);
    run("uvx", [
      "--from", DATAMODEL_CODEGEN,
      "datamodel-codegen",
      "--input", input,
      "--input-file-type", "jsonschema",
      "--output", output,
      "--output-model-type", "pydantic_v2.BaseModel",
      "--use-annotated",
      "--disable-timestamp",
      "--extra-fields", "forbid",
      "--target-python-version", "3.13",
      "--use-standard-collections",
      "--use-union-operator",
      "--enum-field-as-literal", "all",
      "--use-title-as-name",
      "--formatters", "builtin",
      "--custom-file-header", PY_HEADER,
      "--class-name", it.cls,
    ]);
    write(out, `${dir}/${it.module}.py`, readFileSync(output, "utf8"));
  }
  rmSync(tmp, { recursive: true, force: true });

  const messageItems = items.filter((i) => i.type);
  const imports = messageItems.map((i) => `from .${i.module} import ${i.cls}`).join("\n");
  const entries = messageItems.map((i) => `    "${i.type}": ${i.cls},`).join("\n");
  write(
    out,
    `${dir}/registry.py`,
    `${PY_HEADER}
"""Liga o campo \`type\` ao modelo da mensagem."""

from __future__ import annotations

from pydantic import BaseModel

from .envelope import Envelope
${imports}

ENVELOPE_MODEL: type[BaseModel] = Envelope

MESSAGE_MODELS: dict[str, type[BaseModel]] = {
${entries}
}
`,
  );

  // Cópias dos esquemas, na mesma estrutura de pastas (os $ref relativos continuam valendo).
  write(out, `${dir}/schemas/envelope.schema.json`, readFileSync(join(AGENT_SCHEMAS, "envelope.schema.json"), "utf8"));
  for (const m of schemasMeta) {
    write(out, `${dir}/schemas/messages/${m.file}`, readFileSync(join(AGENT_SCHEMAS, "messages", m.file), "utf8"));
  }
}

// ---------------------------------------------------------------------------------------------------------
// (d) e (e) TypeScript
// ---------------------------------------------------------------------------------------------------------

const TS_NOTICE = `/* GERADO por \`${COMMAND}\` — não editar. */\n`;
// O desligamento do lint só entra onde o código gerado o exige (o lint do app avisa de diretiva sem uso).
const TS_HEADER = `/* eslint-disable */\n${TS_NOTICE}`;
const PRETTIER = { singleQuote: true, semi: true, trailingComma: "all", printWidth: 100, tabWidth: 2 };

async function generateTypeScriptHttp(out) {
  const spec = readJson(join(out, OPENAPI_FILE));
  const ast = await openapiTS(spec, { alphabetize: true });
  // Mesmo estilo do PWA (largura 100, aspas simples), para o `prettier --check` do app não reclamar.
  const code = await format(astToString(ast), { parser: "typescript", ...PRETTIER });
  write(out, "apps/web/src/app/core/api/generated/schema.ts", `${TS_HEADER}\n${code}`);
}

async function generateTypeScriptMessages(out, flat) {
  const dir = "apps/web/src/app/core/api/generated/agent";
  const items = [
    { file: "envelope", name: "Envelope", schema: flat.flatEnvelope },
    ...flat.flatMessages.map((m) => ({ file: snake(m.type), name: `${m.name}Message`, schema: m.schema })),
  ];
  for (const it of items) {
    const ts = await compile(structuredClone(it.schema), it.name, {
      bannerComment: "",
      additionalProperties: false,
      format: true,
      style: PRETTIER,
      strictIndexSignatures: true,
      customName: (s) => s.title,
    });
    // Assinatura de índice (corpo livre do envelope) fere uma regra de estilo do app; só então desliga o lint.
    const header = /\[k: string\]|\{\}/.test(ts) ? TS_HEADER : TS_NOTICE;
    write(out, `${dir}/${it.file}.ts`, `${header}\n${ts}`);
  }
  const index = items.map((i) => `export * from './${i.file}';`).join("\n");
  write(out, `${dir}/index.ts`, `${TS_NOTICE}\n${index}\n`);
}

// ---------------------------------------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------------------------------------

/** Gera tudo sob `out` (a própria raiz do repositório no `generate`, uma pasta temporária no `check`). */
export async function generateAll(out) {
  const loaded = loadSchemas();
  const flat = flatten(loaded);

  generateOpenApi(out);
  generateCsharp(out, flat, loaded.messages);
  generatePython(out, flat, loaded.messages);
  await generateTypeScriptHttp(out);
  await generateTypeScriptMessages(out, flat);
}

/** Apaga o que é gerado antes de gerar de novo, para que um esquema removido não deixe arquivo órfão. */
export function cleanGenerated(root) {
  for (const d of GENERATED_DIRS) rmSync(join(root, d), { recursive: true, force: true });
  const py = join(root, GENERATED_PY_DIR);
  if (existsSync(py)) {
    for (const f of readdirSync(py)) {
      if (f.endsWith(".py") && !HAND_WRITTEN_PY.has(f)) rmSync(join(py, f));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Antes de tudo, o `validate`: esquema inválido não gera nada.
  run(process.execPath, [join(CONTRACTS, "scripts", "validate.mjs")], { stdio: "inherit" });
  const staging = join(REPO, "contracts", ".generate-tmp");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    // Gera numa pasta de preparo e só então troca: uma falha no meio não deixa metade dos arquivos.
    await generateAll(staging);
    cleanGenerated(REPO);
    cpSync(staging, REPO, { recursive: true });
    console.log("gerado: openapi, C#, Python, TypeScript");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
