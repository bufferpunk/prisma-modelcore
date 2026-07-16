import fs from 'node:fs'
import path from 'node:path'
import { generateModel, generateEnum, generateRegistry, type PrismaModel, type PrismaEnum } from './parser'

// ---------------------------------------------------------------------------
// DMMF types (subset of the full Prisma DMMF)
// ---------------------------------------------------------------------------

interface DMMFField {
  name: string
  kind: 'scalar' | 'object' | 'enum'
  isList: boolean
  isRequired: boolean
  isUnique: boolean
  isId: boolean
  isUpdatedAt: boolean
  type: string
  relationName: string | null
  relationFromFields: string[] | null
  relationToFields: string[] | null
  default: { name: string; args: any[] } | null
}

interface DMMFModel {
  name: string
  fields: DMMFField[]
}

interface DMMFEnum {
  name: string
  values: string[]
}

interface GeneratorManifest {
  generator: {
    name: string
    output: { value: string; fromEnvVar: string | null }
    config: Record<string, string>
  }
  dmmf: {
    datamodel: {
      models: DMMFModel[]
      enums: DMMFEnum[]
    }
  }
  version: string
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const arg = process.argv.find(a => a.startsWith('--generator-json='))
  if (!arg) {
    process.stderr.write('Missing --generator-json argument\n')
    process.exit(1)
  }

  const jsonPath = arg.split('=')[1]
  let manifest: GeneratorManifest
  try {
    manifest = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
  } catch (e) {
    process.stderr.write(`Failed to read generator JSON: ${e}\n`)
    process.exit(1)
  }

  const outputDir = manifest.generator.output.value
  const dmmfModels = manifest.dmmf.datamodel.models
  const dmmfEnums = manifest.dmmf.datamodel.enums

  const enums: PrismaEnum[] = dmmfEnums.map(e => ({ name: e.name, values: e.values }))
  const enumNames = new Set(enums.map(e => e.name))

  const models: PrismaModel[] = dmmfModels.map(m => ({
    name: m.name,
    fields: m.fields.map(f => dmmfFieldToPrismaField(f, enumNames)),
  }))

  fs.mkdirSync(outputDir, { recursive: true })

  for (const model of models) {
    const code = generateModel(model, enums)
    fs.writeFileSync(path.join(outputDir, `${model.name}.ts`), code)
  }

  for (const enm of enums) {
    const code = generateEnum(enm)
    fs.writeFileSync(path.join(outputDir, `${enm.name}.ts`), code)
  }

  const indexCode = generateRegistry(models, enums)
  fs.writeFileSync(path.join(outputDir, 'index.ts'), indexCode)

  // Signal success to Prisma
  process.stdout.write(JSON.stringify({ version: '1.0.0', generator: { output: { value: outputDir } } }) + '\n')
}

// ---------------------------------------------------------------------------
// DMMF → PrismaField conversion
// ---------------------------------------------------------------------------

function dmmfFieldToPrismaField(field: DMMFField, enumNames: Set<string>): PrismaModel['fields'][0] {
  const attributes: Record<string, string | null> = {}

  if (field.isId) attributes['id'] = null
  if (field.isUnique) attributes['unique'] = null
  if (field.isUpdatedAt) attributes['updatedAt'] = null

  if (field.default) {
    attributes['default'] = dmmfDefaultToString(field.default)
  }

  if (field.relationName) {
    const from = field.relationFromFields?.join(', ') || ''
    const to = field.relationToFields?.join(', ') || ''
    attributes['relation'] = `fields: [${from}], references: [${to}]`
  }

  const isRelation = field.kind === 'object'

  let relationField: string | null = null
  if (field.relationFromFields && field.relationFromFields.length > 0) {
    relationField = field.relationFromFields[0]
  }

  return {
    name: field.name,
    type: field.type,
    isArray: field.isList,
    required: field.isRequired,
    isRelation,
    relationField,
    attributes,
  }
}

function dmmfDefaultToString(def: { name: string; args: any[] }): string {
  switch (def.name) {
    case 'autoincrement':
      return 'autoincrement()'
    case 'now':
      return 'now()'
    case 'uuid':
      return 'uuid()'
    case 'cuid':
      return 'cuid()'
    case 'nanoid':
      return 'nanoid()'
    default: {
      if (def.args.length === 1) {
        const arg = def.args[0]
        if (typeof arg === 'string') return `"${arg}"`
        return String(arg)
      }
      return def.name
    }
  }
}

main()
