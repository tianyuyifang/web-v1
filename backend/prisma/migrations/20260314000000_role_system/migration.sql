-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PENDING', 'MEMBER', 'ADMIN');

-- AlterTable: add role column with default PENDING
ALTER TABLE "users" ADD COLUMN "role" "Role" NOT NULL DEFAULT 'PENDING';

-- AlterTable: drop email column
ALTER TABLE "users" DROP COLUMN IF EXISTS "email";

-- DropTable
DROP TABLE IF EXISTS "password_reset_tokens";
