const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Set pg_trgm.similarity_threshold once per connection (first query triggers it)
let trgmInitialized = false;
prisma.$use(async (params, next) => {
  if (!trgmInitialized) {
    trgmInitialized = true;
    try {
      await prisma.$executeRawUnsafe('SET pg_trgm.similarity_threshold = 0.35');
    } catch {
      // ignore — extension may not be ready yet
    }
  }
  return next(params);
});

module.exports = prisma;
