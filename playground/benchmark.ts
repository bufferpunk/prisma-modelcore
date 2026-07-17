import { PrismaClient } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { modelcoreExtension } from '../dist/index.js'
import { registry } from './src/models/generated/index.js'

async function run() {
  // Pass connection object instead of db instance
  const adapter = new PrismaBetterSqlite3({
    url: 'file:./dev.db',
  })

  // Initialize Prisma Client with the driver adapter
  const prisma = new PrismaClient({ adapter }).$extends(modelcoreExtension(registry as any))

  console.log('--- Cleaning Up Database ---')
  await prisma.post.deleteMany()
  await prisma.user.deleteMany()

  console.log('--- Seeding Database ---')
  const count = 10000
  const usersData = Array.from({ length: count }, (_, i) => ({
    email: `user_${i}@example.com`,
    name: `User ${i}`,
    age: 20 + (i % 50),
  }))

  // Seed using createMany
  await prisma.user.createMany({
    data: usersData,
  })

  console.log(`Seeded ${count} users successfully.\n`)

  console.log('--- Benchmarking Reads ---')
  // 1. Standard read (no hydration)
  const t0 = performance.now()
  const plainUsers = await prisma.user.findMany()
  const t1 = performance.now()
  console.log(`Plain findMany (no hydration): ${(t1 - t0).toFixed(2)} ms (Count: ${plainUsers.length})`)

  // 2. Hydrated read
  const t2 = performance.now()
  const hydratedUsers = await prisma.user.findMany({
    hydrate: true,
  } as any)
  const t3 = performance.now()
  console.log(`Hydrated findMany: ${(t3 - t2).toFixed(2)} ms (Count: ${hydratedUsers.length})`)
  
  const overhead = ((t3 - t2) / (t1 - t0)).toFixed(1)
  console.log(`Hydration overhead factor: ${overhead}x\n`)

  // Verify correctness of class instance
  if (hydratedUsers.length > 0) {
    const user = hydratedUsers[0]
    console.log(`Is user[0] subclass of Base?`, Object.getPrototypeOf(user).constructor.name)
    console.log(`User name: ${user.name}, email: ${user.email}`)
    
    // Test reactive validation on modification
    try {
      console.log('Setting age to invalid type (string)...')
      user.age = 'invalid' as any
      console.log('Failed: No error thrown on invalid assignment')
    } catch (e: any) {
      console.log('Success: Threw error as expected on mutation:', e.message)
    }
  }

  console.log('\n--- Benchmarking Updates & Test Correctness of Update Operators ---')
  try {
    const updated = await prisma.user.update({
      where: { email: 'user_0@example.com' },
      data: {
        age: { increment: 1 } as any, // test standard prisma atomic update
      },
    })
    console.log(`Success: Atomic update { increment: 1 } worked! New age: ${updated.age}`)
  } catch (e: any) {
    console.log(`Failed: Atomic update { increment: 1 } failed with error:`, e.stack || e.message)
  }

  await prisma.$disconnect()
}

run().catch(console.error)
