import http from "http";
import { PrismaClient, Role, Permission, CustomerStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import app from "../src/app";
import { generateToken } from "../src/utils/jwt";

const prisma = new PrismaClient();

let server: http.Server;
let baseUrl: string;

async function setupServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}/api`;
      resolve();
    });
  });
}

async function run() {
  console.log("==================================================");
  console.log("RUNNING ADMIN CUSTOMER REGISTRATION TEST SUITE");
  console.log("==================================================");

  await setupServer();

  try {
    // 1. Setup test employees
    const testAdmin = await prisma.employee.upsert({
      where: { email: "test-admin@secretbrew.test" },
      update: { role: Role.ADMIN, isActive: true },
      create: {
        name: "Test Admin",
        email: "test-admin@secretbrew.test",
        passwordHash: await bcrypt.hash("Password123!", 10),
        role: Role.ADMIN,
        isActive: true
      }
    });

    const testManagerWithPerm = await prisma.employee.upsert({
      where: { email: "test-manager-cust@secretbrew.test" },
      update: { role: Role.MANAGER, isActive: true },
      create: {
        name: "Test Manager Cust",
        email: "test-manager-cust@secretbrew.test",
        passwordHash: await bcrypt.hash("Password123!", 10),
        role: Role.MANAGER,
        isActive: true
      }
    });

    // Grant CUSTOMER_MANAGE to testManagerWithPerm
    await prisma.employeePermission.upsert({
      where: {
        employeeId_permission: {
          employeeId: testManagerWithPerm.id,
          permission: Permission.CUSTOMER_MANAGE
        }
      },
      update: {},
      create: {
        employeeId: testManagerWithPerm.id,
        permission: Permission.CUSTOMER_MANAGE
      }
    });

    const testCashierWithoutPerm = await prisma.employee.upsert({
      where: { email: "test-cashier-noperm@secretbrew.test" },
      update: { role: Role.CASHIER, isActive: true },
      create: {
        name: "Test Cashier NoPerm",
        email: "test-cashier-noperm@secretbrew.test",
        passwordHash: await bcrypt.hash("Password123!", 10),
        role: Role.CASHIER,
        isActive: true
      }
    });

    // Ensure cashier has no CUSTOMER_MANAGE permission
    await prisma.employeePermission.deleteMany({
      where: {
        employeeId: testCashierWithoutPerm.id,
        permission: Permission.CUSTOMER_MANAGE
      }
    });

    const adminToken = generateToken({ id: testAdmin.id, role: testAdmin.role });
    const managerToken = generateToken({ id: testManagerWithPerm.id, role: testManagerWithPerm.role });
    const cashierToken = generateToken({ id: testCashierWithoutPerm.id, role: testCashierWithoutPerm.role });

    const uniquePhone1 = `99${Date.now().toString().slice(-8)}`;
    const uniquePhone2 = `98${Date.now().toString().slice(-8)}`;

    // TEST 1: Admin registers customer
    console.log("\n--- TEST 1: Admin registers customer ---");
    const regRes1 = await fetch(`${baseUrl}/customers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: "Lord Sterling",
        phone: uniquePhone1,
        email: `sterling_${Date.now()}@secretbrew.test`,
        status: "APPROVED"
      })
    });

    const regData1 = await regRes1.json() as any;
    console.log("Status code:", regRes1.status);
    console.log("Response data:", regData1);

    if (regRes1.status !== 201 || !regData1.success || regData1.data?.name !== "Lord Sterling") {
      throw new Error(`TEST 1 Failed: Expected 201 with Lord Sterling, got ${regRes1.status}`);
    }
    if (regData1.data?.status !== "APPROVED") {
      throw new Error(`TEST 1 Failed: Expected status APPROVED, got ${regData1.data?.status}`);
    }
    if (regData1.data?.membership !== "Classic Member") {
      throw new Error(`TEST 1 Failed: Expected Classic Member, got ${regData1.data?.membership}`);
    }
    console.log("✅ TEST 1 PASSED: Admin registered customer successfully with status APPROVED and Classic Member.");

    const createdCustomerId = regData1.data.id;

    // TEST 2: Audit log recorded
    console.log("\n--- TEST 2: Verify Audit Log created ---");
    const audit = await prisma.auditLog.findFirst({
      where: {
        action: "CUSTOMER_CREATED",
        entityId: String(createdCustomerId)
      },
      orderBy: { createdAt: "desc" }
    });

    if (!audit || audit.employeeId !== testAdmin.id) {
      throw new Error("TEST 2 Failed: Audit log for CUSTOMER_CREATED not found or employee mismatch");
    }
    console.log("✅ TEST 2 PASSED: AuditLog recorded with action CUSTOMER_CREATED by employee:", audit.employeeId);

    // TEST 3: One-device policy verification (no fake devices)
    console.log("\n--- TEST 3: Verify no placeholder/fake devices created ---");
    const deviceCount = await prisma.device.count({
      where: { customerId: createdCustomerId }
    });
    if (deviceCount !== 0) {
      throw new Error(`TEST 3 Failed: Customer should have 0 devices at registration, got ${deviceCount}`);
    }
    console.log("✅ TEST 3 PASSED: Exactly 0 devices exist for newly registered customer (device policy intact).");

    // TEST 4: Duplicate phone number protection
    console.log("\n--- TEST 4: Duplicate phone number protection ---");
    const dupRes = await fetch(`${baseUrl}/customers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: "Imposter Sterling",
        phone: uniquePhone1,
        email: "other@example.com",
        status: "APPROVED"
      })
    });

    const dupData = await dupRes.json() as any;
    console.log("Duplicate status code:", dupRes.status);
    console.log("Duplicate message:", dupData.message);

    if (dupRes.status !== 409) {
      throw new Error(`TEST 4 Failed: Expected 409 for duplicate phone, got ${dupRes.status}`);
    }
    if (dupData.message !== "This contact number is already registered.") {
      throw new Error(`TEST 4 Failed: Expected exact message 'This contact number is already registered.', got '${dupData.message}'`);
    }
    console.log("✅ TEST 4 PASSED: Duplicate phone number correctly returned 409 with exact message.");

    // TEST 5: Employee with CUSTOMER_MANAGE permission can register customer
    console.log("\n--- TEST 5: Employee with CUSTOMER_MANAGE permission ---");
    const regRes2 = await fetch(`${baseUrl}/customers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${managerToken}`
      },
      body: JSON.stringify({
        name: "Lady Penelope",
        phone: uniquePhone2,
        status: "APPROVED"
      })
    });

    const regData2 = await regRes2.json() as any;
    console.log("Manager status code:", regRes2.status);
    if (regRes2.status !== 201 || !regData2.success) {
      throw new Error(`TEST 5 Failed: Expected 201 for manager with CUSTOMER_MANAGE, got ${regRes2.status}`);
    }
    console.log("✅ TEST 5 PASSED: Employee with CUSTOMER_MANAGE registered customer successfully.");

    // TEST 6: Employee WITHOUT CUSTOMER_MANAGE permission is blocked (403)
    console.log("\n--- TEST 6: Employee without CUSTOMER_MANAGE is blocked ---");
    const regRes3 = await fetch(`${baseUrl}/customers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cashierToken}`
      },
      body: JSON.stringify({
        name: "Unauthorized Attempt",
        phone: "9199999999",
        status: "APPROVED"
      })
    });

    console.log("Cashier status code:", regRes3.status);
    if (regRes3.status !== 403) {
      throw new Error(`TEST 6 Failed: Expected 403 Forbidden for employee without CUSTOMER_MANAGE, got ${regRes3.status}`);
    }
    console.log("✅ TEST 6 PASSED: Employee without CUSTOMER_MANAGE correctly rejected with 403.");

    // TEST 7: Customer list includes newly registered customer
    console.log("\n--- TEST 7: Customer search / list returns newly registered customer ---");
    const listRes = await fetch(`${baseUrl}/customers?search=${uniquePhone1}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${adminToken}`
      }
    });

    const listData = await listRes.json() as any;
    const found = listData.data?.customers?.find((c: any) => c.phone === uniquePhone1);
    if (!found) {
      throw new Error("TEST 7 Failed: Registered customer not found in search results");
    }
    console.log("Found customer in list:", found.name, found.phone, found.membership);
    console.log("✅ TEST 7 PASSED: Newly created customer searchable and present in customer list.");

    console.log("\n==================================================");
    console.log("ALL 7 TESTS PASSED SUCCESSFULLY!");
    console.log("==================================================");
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error("FATAL TEST ERROR:", err);
  process.exit(1);
});

