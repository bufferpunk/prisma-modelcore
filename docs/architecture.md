# Prisma-ModelCore Architecture & Benchmarks

This document details the internal design decisions, protocol configurations, runtime interception workflows, and performance characteristics under load. It serves as the primary technical reference for maintainers and potential contributors.

---

## 1. Generator Architecture & JSON-RPC Protocol

Prisma generators communicate with the parent Prisma CLI using a standard JSON-RPC 2.0 handshake over standard streams (`stdio`).

### The Stdio Routing Challenge
The Prisma CLI's `GeneratorProcess` spawns child generator processes with a specific standard stream redirection:
*   **`stdin` (fd 0)** is configured as `pipe`. The CLI writes JSON-RPC request payloads here.
*   **`stdout` (fd 1)** is configured as `inherit`. This connects the generator's standard out directly to the active parent shell/terminal for printing purposes. **The CLI does not capture or parse messages sent here.**
*   **`stderr` (fd 2)** is configured as `pipe`. The CLI reads streams from here and parses them as lines. If a line is valid JSON, it processes it as a JSON-RPC response.

### Implementation Solution
To conform to this design:
- All RPC responses (`getManifest` and `generate`) are written directly to **`process.stderr`** rather than `process.stdout`.
- The `readline` engine reading inputs from `process.stdin` omits the `output` stream property (setting it to `undefined`) to prevent any echo-backs or carriage returns from leaking into `process.stdout`.
- Once the `generate` phase completes, the generator notifies the CLI on `process.stderr` and terminates cleanly utilizing `process.exit(0)`.

```
                  ┌──────────────────────┐
                  │      Prisma CLI      │
                  └───────┬──────▲───────┘
                          │      │
     JSON-RPC Request     │      │   JSON-RPC Response
      on stdin (fd 0)     │      │    on stderr (fd 2)
                          ▼      │
                  ┌──────────────────────┐
                  │      Generator       │
                  │ (src/generator.ts)   │
                  └──────────────────────┘
```

---

## 2. Circular Dependencies & Lazy Schema Initialization

When database models have bidirectional relations (e.g. `User` has many `Post`s, and `Post` belongs to `User`), compiling their schema definitions eagerly can trigger a **Temporal Dead Zone (TDZ)** crash at runtime.

### The Problem: Eager Initialization
Initially, schemas were defined using eager class-level static properties:
```typescript
export class User extends Base {
  static schema = {
    posts: { type: Array, values: { type: Post } } // ReferenceError: Post is not defined yet!
  }
}
```
If `User.ts` imports `Post.ts` and `Post.ts` imports `User.ts` (circular relation), one of the classes will be accessed before its class declaration is fully executed, causing a `ReferenceError` during module loading.

### The Solution: Lazy Getters
We resolve circular dependency issues—without resorting to lazy class loaders or dynamic resolution libraries—by compiling schemas with a lazy static getter:
```typescript
export class User extends Base {
  private static _schema: SchemaDefinition | null = null;
  static get schema(): SchemaDefinition {
    if (!User._schema) {
      User._schema = {
        // ... properties defined here ...
      } as const satisfies SchemaDefinition;
    }
    return User._schema;
  }
}
```
This defers schema compilation until runtime validation or hydration actually occurs (on demand), ensuring all generated model classes are fully declared and available in the module scope.

---

## 3. Runtime Interception, Atomic Operators, & Hydration

The `modelcoreExtension` intercepts queries to validate incoming input and hydrate outbound output.

```
Incoming Args ──────────────────────────┐
  │                                     │
  ├── Writes: (create, update, upsert)  │  (Selective Field Validation)
  │     ├── Map fields to Schema        │
  │     └── Bypass Prisma Operators     │
  │            (e.g., connect, set)     │
  │                                     │
  ▼                                     ▼
Prisma DB Query ────────────────────────┘
  │
  ▼
Outbound Result ────────────────────────┐
  │                                     │
  └── Reads: (findMany, findUnique)     │  (Graceful Hydration Boundary)
        ├── If hydrate: true            │
        └── try {wrapSingle(res)}       │
              └── catch -> fallback raw │
```

### Selective Field-Level Validation (Updates)
Prisma updates permit partial datasets (e.g., updating only a user's `name` or `age`). We loop through the update payload's keys:
1. If the key exists in our model's schema, we evaluate it with ModelCore's `runValidate` method.
2. If the value contains Prisma update operators (such as atomic increments `{ increment: 1 }` or relations `{ connect: { id: 2 } }`), validation is bypassed. The extension passes database-level operations through to Prisma safely.

### Hydration Error Boundaries
Output hydration (instantiating ModelCore classes from database records) intercepts the query result stream in `wrapSingle`. 

To prevent schema mismatches, type conflicts, or database/schema drift from crashing query execution loops on read paths:
- The instantiator is wrapped in a robust `try/catch` block.
- If hydration fails, it prints a console warning and falls back to returning the raw database payload directly.

---

## 4. Performance & Latency Benchmarks

To evaluate raw query speed we benchmarked **10,000 query records** with relation inclusions on a Sqlite database. The following latency numbers were recorded:

| Phase / Operation | Raw Latency (ms) | Target Coverage | Engine Action |
| --- | --- | --- | --- |
| **Prisma Generation** | 24 ms - 26 ms | Full datamodel generation | Code emission & index creation |
| **Plain `findMany`** | 733.6 ms | 10k items (un-hydrated) | Database execution |
| **Hydrated `findMany`** | 684.1 ms | 10k items (into `Base` subclasses) | Database execution + Model class hydration |
| **Incremental Updates** | < 2.0 ms | 1 model | Memory filter check in validation loop |

At 10,000 records, the overhead is well within the noise threshold of raw DB operations (overhead factor of ~0.9x to 1.1x). This means hydrating database results into fully validated ModelCore classes introduces virtually **zero noticeable query delay**.

### Running Benchmarks Locally
A benchmark suite is located in the `/playground` directory. To verify changes locally:
1. Build the generator code: `npm run build`
2. Navigate to the sandbox directory: `cd playground`
3. Generate client files and run: `npx prisma generate && npx tsx benchmark.ts`
