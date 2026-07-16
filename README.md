# A Prisma extension for ModelCore

**Runtime entity integrity for your Prisma models.**  
Bridges [Prisma](https://prisma.io) with [ModelCore](https://github.com/bufferpunk/modelcore) so your entities stay validated from the database to the UI and back.

```
npm install prisma-modelcore @bufferpunk/modelcore @prisma/client
```

---

## What it does

One Prisma client.

- **Hydrates** on reads — results become modelcore instances. Validated and continuously enforced.
- **Updates** (`update`, `updateMany`, `upsert`) — always field-validated via `runValidate`. Partial data, full safety.
- **Creates** — pass a ModelCore instance or a plain object. Both work. The instance IS the data.
- **No flag** — zero overhead. Plain Prisma.

```
Reads:
  prisma.user.findMany()                         → plain objects
  prisma.user.findMany({ hydrate: true })         → ModelCore instances

Updates (always validated per field):
  prisma.user.update({ where: { id: 1 }, data: { name: 'Bob' } })
  // name checked against schema — type, min, max, enum, ...

Creates:
  prisma.user.create({ data: User.createFrom({ name: 'Alice' }) })
  prisma.user.create({ data: { name: 'Alice' } })
  // both work — ModelCore instances are clean data, no conversion needed
```

---

## Quick start

### 1. Add the generator to your Prisma schema

```prisma
generator modelcore {
  provider = "prisma-modelcore"
}
```

Then run `prisma generate`. The generator reads the DMMF directly and writes ModelCore classes alongside your Prisma client:

```
src/models/generated/
├── index.ts          # exports all models + `registry` object
├── User.ts
├── Post.ts
├── Role.ts           # Prisma enums become TS enums
└── etc...
```

### 2. Wire up

```ts
import { PrismaClient } from '@prisma/client'
import { modelcoreExtension } from 'prisma-modelcore'
import { registry } from './models/generated'

const prisma = new PrismaClient().$extends(modelcoreExtension(registry))
```

### 3. Reads

```ts
// Plain — zero overhead
const users = await prisma.user.findMany()

// Hydrated — results are ModelCore instances
const users = await prisma.user.findMany({
  hydrate: true,
  include: { posts: true },
})

users[0].name            // "Alice"
users[0].name = 'Bob'    // validated by ModelCore — type, min, max, enum, ...

// Relations are recursively constructed via coercion in the schema
users[0].posts[0]        // Post ModelCore instance — validated on construction
users[0].posts[0].title  // String, validated
```

### 4. Creates

```ts
import { User } from './models/generated'

// ModelCore instance — works directly, no conversion needed
const user = new User({ name: 'Alice', email: 'alice@test.com' })
await prisma.user.create({ data: user })

// Plain object — also works
await prisma.user.create({ data: { name: 'Alice' } })

// With hydrate: true → wraps the returned result too
const created = await prisma.user.create({ data: user, hydrate: true })
// created is a User ModelCore instance
```

### 5. Updates — always validated

```ts
// Every field passes through runValidate against the schema
await prisma.user.update({
  where: { id: 1 },
  data: { name: 'Bob' },
})
// throws if name fails type check, min, max, enum, etc.

// ModelCore instance also works
const update = new User({ name: 'Bob' })
await prisma.user.update({ where: { id: 1 }, data: update, hydrate: true })
// result is a User ModelCore instance
```

### 6. Validate without writing

```ts
const validated = prisma.user.validate({ name: 'Alice', email: 'alice@test.com' })
// Returns a User instance, or throws a ModelCoreError
```

---

## How it works

### Read path

```
No hydrate     ──> query() ──> plain Prisma result
hydrate: true  ──> query() ──> Model.createFrom(result)
                                └── coerce: true on relations → nested instances
```

### Update path

```
For each key in the update data:
  present in schema?
    ├── yes ──> runValidate(conf, value, key, false)  ← throws on invalid
    └── no  ──> skip

Then: query(args)
Then: hydrate? → wrap result if yes
```

### Create path

```
ModelCore instance or plain object → query(args) → result
No transformation needed — instances ARE the data.
```

### `hydrate: true` controls result wrapping only

| Operation | No flag | `hydrate: true` |
|---|---|---|
| `findUnique` | `T \| null` | wrapped `T \| null` |
| `findMany` | `T[]` | wrapped `T[]` |
| `create` | `T` | wrapped `T` |
| `update` | `T` | wrapped `T` |
| `upsert` | `T` | wrapped `T` |
| `delete` | `T` | wrapped `T` |
| `createMany` | `{ count }` | `{ count }` |
| `count`, aggregate | scalar | scalar |

---

## Generated code

### Model files (`src/models/generated/User.ts`)

```ts
import Base, { type SchemaDefinition } from '@bufferpunk/modelcore'
import { Post } from './Post'

export class User extends Base {
  static schema = {
    id:       { type: Number, immutable: true, optional: true },
    name:     { type: String, min: 2, max: 80 },
    email:    { type: String },
    role:     { type: String, enum: Role, optional: true },
    posts:    { type: Array, values: { type: Post, coerce: true }, optional: true },
    bio:      { type: String, optional: true },
    score:    { type: Number, optional: true },
  } as const satisfies SchemaDefinition
}
```

Key details:
- **Relation fields** (like `posts`) get `optional: true, coerce: true` — when Prisma returns them via `include`, ModelCore constructs Post instances from raw data recursively.
- **`@id` fields** → `immutable: true, optional: true`.
- **`@default(autoincrement())`** → `optional: true`.
- **DateTime** → `coerce: true` for string→Date.

**Type mappings:**

| Prisma type | ModelCore type |
|---|---|
| `String` | `String` |
| `Int` | `Number` |
| `Float` | `Number` |
| `Boolean` | `Boolean` |
| `DateTime` | `Date` |
| `Json` | `Object` |
| `Bytes` | `String` |
| `BigInt` | `Number` |
| `Decimal` | `Number` |

**Schema rules:**

| Prisma attribute | Schema config |
|---|---|
| `@id` | `immutable: true, optional: true` |
| `@default(autoincrement())` | `optional: true` |
| `@default(uuid())` / `@default(cuid())` | `optional: true` |
| `@updatedAt` | `default: () => new Date()` |
| `?` (optional field) | `optional: true` |
| Relation field (model type) | `optional: true, coerce: true` |
| `@default("value")` | `default: "value"` |
| `@default(now())` | `default: () => new Date()` |

### Registry (`src/models/generated/index.ts`)

```ts
export { User } from './User'
export { Post } from './Post'

import { User as _User } from './User'
import { Post as _Post } from './Post'

export const registry = {
  User: _User,
  Post: _Post,
} as const

export type Registry = typeof registry
```

### Enums
For example `src/models/generated/Role.ts`
```ts
export enum Role {
  ADMIN = "ADMIN",
  USER = "USER",
}

export const RoleValues = ["ADMIN", "USER"] as const
```

---

## API reference

### `modelcoreExtension(registry)`

```ts
const prisma = new PrismaClient().$extends(modelcoreExtension(registry))
```

| Param | Type | Description |
|---|---|---|
| `registry` | `Record<string, typeof Base>` | Map of model name → ModelCore class (from generated `index.ts`) |

### `prisma.<model>.validate(data)`

Validate data against a model's schema — no database round-trip.

```ts
const user = prisma.user.validate({ name: 'Alice', email: 'alice@test.com' })
// User instance or throws ModelCoreError
```

### `hydrate: true`

Pass on any entity-returning query to wrap the result in ModelCore:

```ts
prisma.user.findMany({ hydrate: true })
prisma.user.findUnique({ where: { id: 1 }, hydrate: true })
prisma.user.create({ data: user, hydrate: true })
prisma.user.update({ where: { id: 1 }, data: update, hydrate: true })
prisma.user.upsert({ where: { id: 1 }, create, update, hydrate: true })
prisma.user.delete({ where: { id: 1 }, hydrate: true })
```

---

## Design rationale

### Why `coerce: true` on relation fields?

Generated schemas include relation fields with `coerce: true` and `optional: true`. When Prisma returns data with `include`, ModelCore's constructor calls `new RelatedModel(data)` for each item — recursively validating the entire tree. No separate wrapping step needed.

### Why field-level validation on updates?

ModelCore's `runValidate(conf, value, path, isNew)` validates a single field against its schema config. Updates pass each key through `runValidate` individually — partial data like `{ name: 'Bob' }` gets the same safety as full construction without requiring every field to be present.

---

## Limitations

- **`select` queries**: Partial results may omit required schema fields, causing `Model` instantiation to throw when hydrating. Use `include` for full wrapping, or make fields `optional` in your schema.
- **`_count` includes**: Passed through as-is (not a model).
- **Raw queries**: `$queryRaw` / `$executeRaw` have no model context — not intercepted.

---

## License
MIT © [bufferpunk](https://bufferpunk.com)

