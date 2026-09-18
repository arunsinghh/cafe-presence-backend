-- CreateEnum
CREATE TYPE "Permission" AS ENUM ('DASHBOARD_VIEW', 'CUSTOMER_VIEW', 'CUSTOMER_MANAGE', 'EMPLOYEE_VIEW', 'EMPLOYEE_MANAGE', 'VOUCHER_VIEW', 'VOUCHER_CREATE', 'VOUCHER_MANAGE', 'VOUCHER_REDEEM', 'PRESENCE_VIEW', 'PRESENCE_VERIFY', 'PRESENCE_MANAGE', 'PURCHASE_VIEW', 'PURCHASE_CREATE', 'PURCHASE_MANAGE', 'LOYALTY_VIEW', 'LOYALTY_MANAGE', 'CAFE_CONFIG_VIEW', 'CAFE_CONFIG_MANAGE', 'AUDIT_LOG_VIEW');

-- CreateTable
CREATE TABLE "EmployeePermission" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "permission" "Permission" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeePermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeePermission_employeeId_idx" ON "EmployeePermission"("employeeId");

-- CreateIndex
CREATE INDEX "EmployeePermission_permission_idx" ON "EmployeePermission"("permission");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeePermission_employeeId_permission_key" ON "EmployeePermission"("employeeId", "permission");

-- AddForeignKey
ALTER TABLE "EmployeePermission" ADD CONSTRAINT "EmployeePermission_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
