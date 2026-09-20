-- CreateEnum
CREATE TYPE "RedemptionSessionStatus" AS ENUM ('CREATED', 'SCANNED', 'OTP_VERIFIED', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Voucher" ADD COLUMN     "imageUrl" TEXT;

-- CreateTable
CREATE TABLE "VoucherRedemptionSession" (
    "id" SERIAL NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "customerId" INTEGER NOT NULL,
    "customerVoucherId" INTEGER NOT NULL,
    "voucherId" INTEGER NOT NULL,
    "status" "RedemptionSessionStatus" NOT NULL DEFAULT 'CREATED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scannedAt" TIMESTAMP(3),
    "scannedByEmployeeId" INTEGER,
    "otpHash" TEXT,
    "otpEncrypted" TEXT,
    "otpExpiresAt" TIMESTAMP(3),
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "maxOtpAttempts" INTEGER NOT NULL DEFAULT 3,
    "verifiedAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "redeemedByEmployeeId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoucherRedemptionSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Benefit" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "imageUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Benefit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoucherRedemptionSession_sessionToken_key" ON "VoucherRedemptionSession"("sessionToken");

-- CreateIndex
CREATE INDEX "VoucherRedemptionSession_sessionToken_idx" ON "VoucherRedemptionSession"("sessionToken");

-- CreateIndex
CREATE INDEX "VoucherRedemptionSession_customerId_status_idx" ON "VoucherRedemptionSession"("customerId", "status");

-- CreateIndex
CREATE INDEX "VoucherRedemptionSession_customerVoucherId_status_idx" ON "VoucherRedemptionSession"("customerVoucherId", "status");

-- CreateIndex
CREATE INDEX "VoucherRedemptionSession_status_expiresAt_idx" ON "VoucherRedemptionSession"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Benefit_active_displayOrder_idx" ON "Benefit"("active", "displayOrder");

-- AddForeignKey
ALTER TABLE "VoucherRedemptionSession" ADD CONSTRAINT "VoucherRedemptionSession_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemptionSession" ADD CONSTRAINT "VoucherRedemptionSession_customerVoucherId_fkey" FOREIGN KEY ("customerVoucherId") REFERENCES "CustomerVoucher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemptionSession" ADD CONSTRAINT "VoucherRedemptionSession_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "Voucher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemptionSession" ADD CONSTRAINT "VoucherRedemptionSession_scannedByEmployeeId_fkey" FOREIGN KEY ("scannedByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemptionSession" ADD CONSTRAINT "VoucherRedemptionSession_redeemedByEmployeeId_fkey" FOREIGN KEY ("redeemedByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

