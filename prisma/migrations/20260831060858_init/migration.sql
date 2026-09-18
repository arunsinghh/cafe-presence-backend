/*
  Warnings:

  - The values [ACTIVE] on the enum `QrStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "QrStatus_new" AS ENUM ('PENDING', 'CONSUMED', 'EXPIRED', 'REVOKED');
ALTER TABLE "DynamicQrToken" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "DynamicQrToken" ALTER COLUMN "status" TYPE "QrStatus_new" USING ("status"::text::"QrStatus_new");
ALTER TYPE "QrStatus" RENAME TO "QrStatus_old";
ALTER TYPE "QrStatus_new" RENAME TO "QrStatus";
DROP TYPE "QrStatus_old";
ALTER TABLE "DynamicQrToken" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterTable
ALTER TABLE "DynamicQrToken" ALTER COLUMN "status" SET DEFAULT 'PENDING';
