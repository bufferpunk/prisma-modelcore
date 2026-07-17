import { Prisma } from '@prisma/client/extension'
import Base from '@bufferpunk/modelcore'

// ---------------------------------------------------------------------------
// Operation classification
// ---------------------------------------------------------------------------

const ENTITY_RETURNING_OPS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
  'create', 'update', 'upsert', 'delete',
])

const UPDATE_OPS = new Set(['update', 'updateMany', 'upsert'])

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export function modelcoreExtension(registry: Record<string, typeof Base>) {
  return Prisma.defineExtension({
    name: 'modelcore',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model) return query(args)

          const modelName = model as string

          // Update operations — field-validate partial data via runValidate
          if (UPDATE_OPS.has(operation)) {
            validateUpdateData(modelName, operation, args, registry)
          }

          const shouldHydrate = !!(args as any)?.hydrate
          if (!shouldHydrate) return query(args)

          delete (args as any).hydrate
          const result = await query(args)

          if (ENTITY_RETURNING_OPS.has(operation)) {
            return wrapResult(result, modelName, registry)
          }

          return result
        },
      },
    },
    model: {
      $allModels: {
        validate<T>(this: T, data: any) {
          const ctx = Prisma.getExtensionContext(this) as any
          const Model = registry[ctx.$name]
          if (!Model) throw new Error(`No ModelCore model registered for "${ctx.$name}"`)
          return Model.createFrom(data)
        },
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Update validation — field-level using ModelCore's runValidate
// ---------------------------------------------------------------------------

const PRISMA_OPERATORS = new Set([
  'set', 'increment', 'decrement', 'multiply', 'divide', 'push', 'unset',
  'connect', 'disconnect', 'create', 'connectOrCreate', 'delete', 'update', 'upsert', 'updateMany', 'deleteMany'
])

function isPrismaOperator(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return false
  const keys = Object.keys(value as object)
  return keys.length > 0 && keys.every(k => PRISMA_OPERATORS.has(k))
}

function validateUpdateData(
  model: string,
  operation: string,
  args: any,
  registry: Record<string, typeof Base>,
): void {
  const Model = registry[model]
  if (!Model) return
  const schema = Model.schema as Record<string, any>

  const data =
    operation === 'upsert'
      ? { ...(args.create || {}), ...(args.update || {}) }
      : args.data

  if (!data || typeof data !== 'object') return

  const runValidate = (Model.prototype as any).runValidate
  if (typeof runValidate !== 'function') return

  for (const [key, value] of Object.entries(data) as [string, any][]) {
    const conf = schema[key]
    if (!conf) continue
    if (isPrismaOperator(value)) continue

    runValidate.call(Model.prototype, conf, value, key, false)
  }
}

// ---------------------------------------------------------------------------
// Result wrapping — only when hydrate: true
// ---------------------------------------------------------------------------

function wrapResult(
  result: any,
  modelName: string,
  registry: Record<string, typeof Base>,
): any {
  if (result == null) return result
  if (Array.isArray(result)) return result.map(r => wrapSingle(r, modelName, registry))
  return wrapSingle(result, modelName, registry)
}

function wrapSingle(
  result: any,
  modelName: string,
  registry: Record<string, typeof Base>,
): any {
  const Model = registry[modelName]
  if (!Model) return result
  try {
    return Model.createFrom(result)
  } catch (error) {
    console.warn(`[modelcoreExtension] Warning: failed to hydrate model "${modelName}":`, error)
    return result
  }
}
