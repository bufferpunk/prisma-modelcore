import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Configuration — adjust these for your project
// ---------------------------------------------------------------------------

const PRISMA_SCHEMA_PATH = path.join(process.cwd(), 'schema.prisma');
const OUTPUT_DIR = path.join(process.cwd(), 'src', 'models', 'generated');
const MODELCORE_IMPORT = '@bufferpunk/modelcore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrismaField {
  name: string;
  type: string;
  isArray: boolean;
  required: boolean;
  isRelation: boolean;
  relationField: string | null;
  attributes: Record<string, string | null>;
}

export interface PrismaModel {
  name: string;
  fields: PrismaField[];
}

export interface PrismaEnum {
  name: string;
  values: string[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function generate() {
  const schema = fs.readFileSync(PRISMA_SCHEMA_PATH, 'utf-8');
  const { models, enums } = parseSchema(schema);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const model of models) {
    const code = generateModel(model, enums);
    const filePath = path.join(OUTPUT_DIR, `${model.name}.ts`);
    fs.writeFileSync(filePath, code);
  }

  for (const enm of enums) {
    const code = generateEnum(enm);
    const filePath = path.join(OUTPUT_DIR, `${enm.name}.ts`);
    fs.writeFileSync(filePath, code);
  }

  const indexCode = generateRegistry(models, enums);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.ts'), indexCode);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseSchema(schema: string) {
  const models: PrismaModel[] = [];
  const enumsList: PrismaEnum[] = [];

  const lines = schema.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('model ')) {
      const result = parseModelBlock(lines, i);
      models.push(result.model);
      i = result.nextIndex;
    } else if (trimmed.startsWith('enum ')) {
      const result = parseEnumBlock(lines, i);
      enumsList.push(result.enm);
      i = result.nextIndex;
    } else {
      i++;
    }
  }

  return { models, enums: enumsList };
}

function parseModelBlock(lines: string[], startIndex: number) {
  const header = lines[startIndex].trim();
  const nameMatch = header.match(/^model\s+(\w+)\s*\{/);
  if (!nameMatch) throw new Error(`Invalid model declaration at line ${startIndex + 1}: ${header}`);
  const name = nameMatch[1];

  const fields: PrismaField[] = [];
  let i = startIndex + 1;
  let braceDepth = 1;

  while (i < lines.length && braceDepth > 0) {
    const trimmed = lines[i].trim();

    if (trimmed.includes('{')) braceDepth++;
    if (trimmed.includes('}')) {
      braceDepth--;
      if (braceDepth === 0) break;
    }

    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('@@')) {
      const field = parseFieldLine(trimmed);
      if (field) fields.push(field);
    }

    i++;
  }

  return { model: { name, fields }, nextIndex: i + 1 };
}

function parseEnumBlock(lines: string[], startIndex: number) {
  const header = lines[startIndex].trim();
  const nameMatch = header.match(/^enum\s+(\w+)\s*\{/);
  if (!nameMatch) throw new Error(`Invalid enum declaration at line ${startIndex + 1}: ${header}`);

  const name = nameMatch[1];
  const values: string[] = [];
  let i = startIndex + 1;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === '}') break;
    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('@@')) {
      const val = trimmed.replace(/@.*/, '').trim();
      if (val) values.push(val);
    }
    i++;
  }

  return { enm: { name, values }, nextIndex: i + 1 };
}

function parseFieldLine(trimmed: string): PrismaField | null {
  if (!trimmed || trimmed.startsWith('@@') || trimmed.startsWith('//')) return null;

  const fieldRegex = /^(\w+)\s+(\w+(?:\[\])?)(\??)\s*(.*)$/;
  const match = trimmed.match(fieldRegex);
  if (!match) return null;

  const fieldName = match[1];
  let rawType = match[2];
  const optionalMarker = match[3];
  const attrsStr = match[4];

  const isArray = rawType.endsWith('[]');
  if (isArray) rawType = rawType.slice(0, -2);

  const required = optionalMarker !== '?';
  const attributes = parseAttributes(attrsStr);
  const isRelation = 'relation' in attributes || isRelationFieldType(rawType);

  let relationField: string | null = null;
  if (attributes['relation']) {
    const relMatch = attributes['relation']?.match(/fields:\s*\[([^\]]+)\]/);
    if (relMatch) relationField = relMatch[1];
  }

  return { name: fieldName, type: rawType, isArray, required, isRelation, relationField, attributes };
}

function parseAttributes(attrsStr: string): Record<string, string | null> {
  const attrs: Record<string, string | null> = {};

  const re = /@(\w+)/g;
  let m;

  while ((m = re.exec(attrsStr)) !== null) {
    const key = m[1];
    let val: string | null = null;
    const rest = attrsStr.slice(re.lastIndex).trimStart();

    if (rest.startsWith('(')) {
      let depth = 0;
      let end = 0;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '(') depth++;
        else if (rest[i] === ')') {
          depth--;
          if (depth === 0) { end = i + 1; break; }
        }
      }
      if (end > 0) {
        val = rest.slice(1, end - 1).trim();
        re.lastIndex += end;
      }
    }

    attrs[key] = val;
  }

  return attrs;
}

const prismaScalarTypes = new Set([
  'String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Bytes', 'BigInt', 'Decimal',
]);

function isRelationFieldType(type: string): boolean {
  if (prismaScalarTypes.has(type)) return false;
  return /^[A-Z]/.test(type);
}


// ---------------------------------------------------------------------------
// Type Mapping
// ---------------------------------------------------------------------------

const typeMap: Record<string, string> = {
  String: 'String',
  Int: 'Number',
  Float: 'Number',
  Decimal: 'Number',
  BigInt: 'Number',
  Boolean: 'Boolean',
  DateTime: 'Date',
  Json: 'Object',
  Bytes: 'String',
};

// ---------------------------------------------------------------------------
// Code Generation
// ---------------------------------------------------------------------------

export function generateModel(model: PrismaModel, enums: PrismaEnum[]): string {
  const enumNames = new Set(enums.map((e) => e.name));

  const fieldEntries: { entry: string; usedTypes: string[] }[] = [];
  for (const field of model.fields) {
    const result = generateFieldEntry(field, enumNames);
    if (result) fieldEntries.push(result);
  }

  const referencedModels = new Set<string>();
  const referencedEnums = new Set<string>();
  for (const fe of fieldEntries) {
    for (const t of fe.usedTypes) {
      if (enumNames.has(t)) referencedEnums.add(t);
      else referencedModels.add(t);
    }
  }

  let code = `import Base, { type SchemaDefinition } from '${MODELCORE_IMPORT}';\n\n// Auto-generated by prisma-modelcore. Do not edit manually!\n\n`;

  for (const ref of [...referencedModels].sort()) {
    code += `import { ${ref} } from './${ref}';\n`;
  }
  for (const ref of [...referencedEnums].sort()) {
    code += `import { ${ref} } from './${ref}';\n`;
  }

  code += '\n';

  code += `export class ${model.name} extends Base {\n`;
  code += `  private static _schema: SchemaDefinition | null = null;\n`;
  code += `  static get schema(): SchemaDefinition {\n`;
  code += `    if (!${model.name}._schema) {\n`;
  code += `      ${model.name}._schema = {\n`;

  code += fieldEntries.map((fe) => fe.entry).join('\n');
  code += `\n      } as const satisfies SchemaDefinition;\n`;
  code += `    }\n`;
  code += `    return ${model.name}._schema;\n`;
  code += `  }\n`;
  code += `}\n`;

  return code;
}

function generateFieldEntry(field: PrismaField, enumNames: Set<string>): { entry: string; usedTypes: string[] } | null {
  const config: string[] = [];
  const usedTypes: string[] = [];
  const isEnumType = enumNames.has(field.type);
  const isModelType = !isEnumType && field.isRelation && /^[A-Z]/.test(field.type);

  // Type
  const mcType = getModelCoreType(field, enumNames);
  if (field.isArray) {
    config.push('type: Array');
  } else {
    config.push(`type: ${mcType}`);
  }

  // Track whether this field should be optional — deduplicated into a single flag
  let isOptional = false;

  // Relation fields — optional (not always included in results), with coerce for nested validation
  if (isModelType) {
    isOptional = true;
    config.push('coerce: true');
  }

  // Required / Optional from Prisma schema
  if (!field.required && !isModelType) isOptional = true;

  // @id fields — database-generated, not required for construction
  if ('id' in field.attributes) {
    config.push('immutable: true');
    isOptional = true;
  }

  // @default(autoincrement()) — DB auto-generates
  if (field.attributes['default']?.trim() === 'autoincrement()') {
    isOptional = true;
  }

  // @default(uuid()) / @default(cuid()) — auto-generated
  const autoGenDefaults = new Set(['uuid()', 'cuid()', 'nanoid()']);
  if (field.attributes['default'] && autoGenDefaults.has(field.attributes['default']!.trim())) {
    isOptional = true;
  }

  if (isOptional) config.push('optional: true');

  // @updatedAt — auto-set by Prisma on update
  if ('updatedAt' in field.attributes) {
    config.push('default: () => new Date()');
  }

  // Default value from Prisma schema
  if ('default' in field.attributes) {
    const def = parseDefaultValue(field.attributes['default']!, field.type);
    if (def !== null) config.push(`default: ${def}`);
  }

  // DateTime fields — coerce string/Date from JSON
  if (field.type === 'DateTime') {
    config.push('coerce: true');
  }

  // Pass through custom attributes as field config
  const prismaAttrs = new Set(['id', 'default', 'unique', 'relation', 'updatedAt', 'map', 'ignore']);
  for (const [key, val] of Object.entries(field.attributes)) {
    if (prismaAttrs.has(key)) continue;
    if (val === null) {
      config.push(`${key}: true`);
    } else {
      config.push(`${key}: ${val}`);
    }
  }

  // Array values type
  if (field.isArray) {
    const valType = isEnumType ? 'String' : mcType;
    const valParts: string[] = [`type: ${valType}`];
    if (isEnumType) valParts.push(`enum: ${field.type}`);
    if (isModelType) valParts.push('coerce: true');
    config.push(`values: { ${valParts.join(', ')} }`);
    if (!isEnumType) usedTypes.push(mcType);
  }

  // Enum field type
  if (isEnumType && !field.isArray) {
    config.push(`type: String, enum: ${field.type}`);
    usedTypes.push(field.type);
  }

  // Track model type for import generation
  if (isModelType && !field.isArray) {
    usedTypes.push(mcType);
  }

  return { entry: `    ${field.name}: { ${config.join(', ')} },`, usedTypes };
}

function getModelCoreType(field: PrismaField, enumNames: Set<string>): string {
  if (enumNames.has(field.type)) return 'String';

  if (field.isRelation && /^[A-Z]/.test(field.type)) return field.type;

  return typeMap[field.type] || 'String';
}

function parseDefaultValue(def: string, prismaType: string): string | null {
  def = def.trim();

  if (def === 'autoincrement()') return null;
  if (def === 'now()' || def === 'now') return '() => new Date()';
  if (def === 'true') return 'true';
  if (def === 'false') return 'false';
  if (def === 'uuid()' || def === 'cuid()' || def === 'nanoid()') return null;

  if (def.startsWith('"') || def.startsWith("'")) return def;
  if (def.startsWith('[') || def.startsWith('{')) return def;

  if (/^-?\d+(\.\d+)?$/.test(def)) return def;

  return `"${def}"`;
}

// ---------------------------------------------------------------------------
// Registry Generation
// ---------------------------------------------------------------------------

export function generateRegistry(models: PrismaModel[], enums: PrismaEnum[]): string {
  const modelNames = models.map(m => m.name).sort();
  const enumNames = enums.map(e => e.name).sort();
  const allNames = [...modelNames, ...enumNames].sort();

  let code = '// Auto-generated by prisma-modelcore — do not edit manually\n\n';

  for (const name of allNames) {
    code += `export { ${name} } from './${name}';\n`;
  }

  code += '\n';

  for (const name of modelNames) {
    code += `import { ${name} as _${name} } from './${name}';\n`;
  }

  code += '\n';

  code += 'export const registry = {\n';
  for (const name of modelNames) {
    code += `  ${name}: _${name},\n`;
  }
  code += '} as const;\n\n';

  code += 'export type Registry = typeof registry;\n';

  return code;
}

// ---------------------------------------------------------------------------
// Enum Generation
// ---------------------------------------------------------------------------

export function generateEnum(enm: PrismaEnum): string {
  let code = `export enum ${enm.name} {\n`;
  for (const value of enm.values) {
    code += `  ${value} = "${value}",\n`;
  }
  code += '}\n\n';
  code += `export const ${enm.name}Values = [${enm.values.map((v) => `"${v}"`).join(', ')}] as const;\n`;
  return code;
}
