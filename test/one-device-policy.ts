/**
 * ONE-DEVICE-PER-CUSTOMER POLICY TEST SUITE
 *
 * Tests the strict one-device enforcement in POST /api/auth/customer/login
 * and the admin device replacement via POST /api/devices/:id/replace.
 *
 * Runs against: http://localhost:4000/api
 */

import { prisma } from "../src/config/prisma";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:4000/api";

let adminToken = "";
let testCustomerId = 0;
let testCustomerPhone = "";
let deviceAId = 0;
let deviceAInstallationId = "";
let deviceBInstallationId = "";
let customerTokenDeviceA = "";

let passed = 0;
let total = 0;

function assert(
  label: string,
  condition: boolean,
  detail?: string
) {
  total++;
  if (condition) {
    passed++;
    console.log(`✅ PASS: ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    console.log(`❌ FAIL: ${label}${detail ? ` (${detail})` : ""}`);
  }
}

async function setup() {
  // Ensure admin exists
  const adminEmail = "device-test-admin@cafe.test";
  const adminPassword = "TestAdmin123!";
  const hash = await bcrypt.hash(adminPassword, 10);

  let admin = await prisma.employee.findUnique({
    where: { email: adminEmail }
  });

  if (!admin) {
    admin = await prisma.employee.create({
      data: {
        name: "Device Test Admin",
        email: adminEmail,
        passwordHash: hash,
        role: "ADMIN",
        isActive: true
      }
    });
  }

  // Login admin
  const loginRes = await fetch(`${BASE}/auth/employee/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: adminEmail,
      password: adminPassword
    })
  });
  const loginData = await loginRes.json();
  adminToken = loginData.data?.token || loginData.token;

  // Create a test customer with unique phone
  testCustomerPhone = `9876${Date.now().toString().slice(-6)}`;
  const customer = await prisma.customer.create({
    data: {
      name: "One Device Test Customer",
      phone: testCustomerPhone,
      status: "APPROVED",
      approvedAt: new Date()
    }
  });
  testCustomerId = customer.id;

  deviceAInstallationId = `INSTALL_A_${Date.now()}`;
  deviceBInstallationId = `INSTALL_B_${Date.now()}`;

  console.log(
    `\nTest customer: id=${testCustomerId}, phone=${testCustomerPhone}`
  );
  console.log(`Device A installation ID: ${deviceAInstallationId}`);
  console.log(`Device B installation ID: ${deviceBInstallationId}\n`);
}

async function test1_firstDeviceRegisters() {
  // First login from Device A — should create PENDING device
  const res = await fetch(`${BASE}/auth/customer/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone: testCustomerPhone,
      deviceId: deviceAInstallationId
    })
  });

  const data = await res.json();

  // Should be 403 (device awaiting approval) — first time registration
  assert(
    "[Case 1] First device registers as PENDING",
    res.status === 403 && data.errors?.status === "PENDING",
    `Status: ${res.status}, DeviceStatus: ${data.errors?.status}`
  );

  // Get the device ID from DB
  const device = await prisma.device.findFirst({
    where: {
      customerId: testCustomerId,
      deviceId: deviceAInstallationId
    }
  });

  assert(
    "[Case 1b] Device A exists in DB with PENDING status",
    device !== null && device.status === "PENDING",
    `DB Status: ${device?.status}`
  );

  if (device) {
    deviceAId = device.id;

    // Admin approves Device A
    const approveRes = await fetch(
      `${BASE}/devices/${deviceAId}/approve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`
        }
      }
    );
    const approveData = await approveRes.json();
    assert(
      "[Case 1c] Admin approves Device A",
      approveRes.status === 200 && approveData.data?.status === "ACTIVE",
      `Status: ${approveRes.status}, DeviceStatus: ${approveData.data?.status}`
    );
  }
}

async function test2_sameDeviceLoginSucceeds() {
  // Login again from Device A — should succeed with a token
  const res = await fetch(`${BASE}/auth/customer/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone: testCustomerPhone,
      deviceId: deviceAInstallationId
    })
  });

  const data = await res.json();

  assert(
    "[Case 2] Same device login succeeds",
    res.status === 200 && !!data.data?.token,
    `Status: ${res.status}, HasToken: ${!!data.data?.token}`
  );

  customerTokenDeviceA = data.data?.token || "";
}

async function test3_differentDeviceBlocked() {
  // Login from Device B — should be blocked with DEVICE_ALREADY_REGISTERED
  const res = await fetch(`${BASE}/auth/customer/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone: testCustomerPhone,
      deviceId: deviceBInstallationId
    })
  });

  const data = await res.json();

  assert(
    "[Case 3] Different device blocked with DEVICE_ALREADY_REGISTERED",
    res.status === 409 && data.error === "DEVICE_ALREADY_REGISTERED",
    `Status: ${res.status}, Error: ${data.error}`
  );

  // Verify the message includes the phone number
  assert(
    "[Case 3b] Error message includes customer phone number",
    data.message?.includes(testCustomerPhone),
    `Message: ${data.message}`
  );
}

async function test4_noUnauthorizedDeviceCreated() {
  // Check database — Device B must NOT exist
  const deviceB = await prisma.device.findFirst({
    where: {
      customerId: testCustomerId,
      deviceId: deviceBInstallationId
    }
  });

  assert(
    "[Case 4] Device B was NOT created in database",
    deviceB === null,
    `DeviceB found: ${deviceB !== null}${deviceB ? `, status: ${deviceB.status}` : ""}`
  );
}

async function test5_deviceAContinuesWorking() {
  // Use Device A's token to access a protected customer API
  const res = await fetch(`${BASE}/customers/profile/me`, {
    headers: {
      Authorization: `Bearer ${customerTokenDeviceA}`
    }
  });

  const data = await res.json();

  assert(
    "[Case 5] Device A still works on protected APIs",
    res.status === 200 && data.success === true,
    `Status: ${res.status}, CustomerId: ${data.data?.id || data.customer?.id}`
  );
}

async function test6_adminReplacesDevice() {
  // Admin replaces Device A
  const res = await fetch(
    `${BASE}/devices/${deviceAId}/replace`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      }
    }
  );

  const data = await res.json();

  assert(
    "[Case 6] Admin replaces Device A successfully",
    res.status === 200 &&
      data.data?.replacedDevice?.newStatus === "REVOKED",
    `Status: ${res.status}, NewStatus: ${data.data?.replacedDevice?.newStatus}`
  );

  // Verify in DB
  const deviceA = await prisma.device.findUnique({
    where: { id: deviceAId }
  });

  assert(
    "[Case 6b] Device A is REVOKED in database",
    deviceA?.status === "REVOKED",
    `DB Status: ${deviceA?.status}`
  );

  // Verify audit log exists
  const auditLog = await prisma.auditLog.findFirst({
    where: {
      action: "DEVICE_REPLACED",
      entityId: String(deviceAId)
    },
    orderBy: { createdAt: "desc" }
  });

  assert(
    "[Case 6c] DEVICE_REPLACED audit log created",
    auditLog !== null,
    `AuditLogId: ${auditLog?.id}`
  );
}

async function test7_deviceBCanRegisterAfterReplacement() {
  // Device B tries registration again — should work now (first-time flow)
  const res = await fetch(`${BASE}/auth/customer/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone: testCustomerPhone,
      deviceId: deviceBInstallationId
    })
  });

  const data = await res.json();

  assert(
    "[Case 7] Device B can register after replacement",
    res.status === 403 && data.errors?.status === "PENDING",
    `Status: ${res.status}, DeviceStatus: ${data.errors?.status}`
  );

  // Get Device B's DB id and approve it
  const deviceB = await prisma.device.findFirst({
    where: {
      customerId: testCustomerId,
      deviceId: deviceBInstallationId
    }
  });

  if (deviceB) {
    const approveRes = await fetch(
      `${BASE}/devices/${deviceB.id}/approve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`
        }
      }
    );

    assert(
      "[Case 8] Device B approved and ACTIVE",
      approveRes.status === 200,
      `Status: ${approveRes.status}`
    );

    // Login from Device B should now succeed
    const loginRes = await fetch(`${BASE}/auth/customer/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: testCustomerPhone,
        deviceId: deviceBInstallationId
      })
    });

    const loginData = await loginRes.json();

    assert(
      "[Case 8b] Device B login successful after approval",
      loginRes.status === 200 && !!loginData.data?.token,
      `Status: ${loginRes.status}, HasToken: ${!!loginData.data?.token}`
    );
  }
}

async function test9_oldJwtRejected() {
  // Device A's old JWT should now fail
  const res = await fetch(`${BASE}/customers/profile/me`, {
    headers: {
      Authorization: `Bearer ${customerTokenDeviceA}`
    }
  });

  assert(
    "[Case 9] Old Device A JWT rejected on protected API",
    res.status === 403 || res.status === 401,
    `Status: ${res.status}`
  );
}

async function test10_raceCondition() {
  // Create a new customer for race condition test
  const racePhone = `9877${Date.now().toString().slice(-6)}`;
  const raceCustomer = await prisma.customer.create({
    data: {
      name: "Race Test Customer",
      phone: racePhone,
      status: "APPROVED",
      approvedAt: new Date()
    }
  });

  const deviceC = `INSTALL_RACE_C_${Date.now()}`;
  const deviceD = `INSTALL_RACE_D_${Date.now()}`;

  // Send two simultaneous registration requests
  const [resC, resD] = await Promise.all([
    fetch(`${BASE}/auth/customer/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: racePhone,
        deviceId: deviceC
      })
    }),
    fetch(`${BASE}/auth/customer/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: racePhone,
        deviceId: deviceD
      })
    })
  ]);

  const statuses = [resC.status, resD.status].sort();

  // One should get 403 (PENDING registration) and the other should get 409 (blocked)
  // OR both could get 403 if they are the same device (which they aren't)
  // The key assertion: NOT both get 403 (which would mean two devices were created)
  const pendingCount = statuses.filter((s) => s === 403).length;
  const blockedCount = statuses.filter((s) => s === 409).length;

  assert(
    "[Case 10] Race condition: only one device registered",
    pendingCount === 1 && blockedCount === 1,
    `Statuses: [${statuses}], Pending: ${pendingCount}, Blocked: ${blockedCount}`
  );

  // Verify in DB: only one device should exist for this customer
  const raceDevices = await prisma.device.findMany({
    where: {
      customerId: raceCustomer.id,
      status: { in: ["PENDING", "ACTIVE"] }
    }
  });

  assert(
    "[Case 10b] Only one device exists in DB for race customer",
    raceDevices.length === 1,
    `Devices found: ${raceDevices.length}`
  );
}

async function test11_reinstallTreatedAsNewDevice() {
  // Simulate uninstall/reinstall by using a NEW installation ID
  // for the customer who already has Device B active
  const reinstallId = `INSTALL_REINSTALL_${Date.now()}`;

  const res = await fetch(`${BASE}/auth/customer/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone: testCustomerPhone,
      deviceId: reinstallId
    })
  });

  const data = await res.json();

  assert(
    "[Case 11] Reinstall treated as different device — blocked",
    res.status === 409 && data.error === "DEVICE_ALREADY_REGISTERED",
    `Status: ${res.status}, Error: ${data.error}`
  );

  // Verify no device was created
  const reinstallDevice = await prisma.device.findFirst({
    where: {
      customerId: testCustomerId,
      deviceId: reinstallId
    }
  });

  assert(
    "[Case 11b] Reinstall device NOT created in database",
    reinstallDevice === null,
    `Found: ${reinstallDevice !== null}`
  );
}

async function main() {
  console.log("==================================================");
  console.log("ONE-DEVICE-PER-CUSTOMER POLICY TEST SUITE");
  console.log("==================================================\n");

  await setup();

  await test1_firstDeviceRegisters();
  await test2_sameDeviceLoginSucceeds();
  await test3_differentDeviceBlocked();
  await test4_noUnauthorizedDeviceCreated();
  await test5_deviceAContinuesWorking();
  await test6_adminReplacesDevice();
  await test7_deviceBCanRegisterAfterReplacement();
  await test9_oldJwtRejected();
  await test10_raceCondition();
  await test11_reinstallTreatedAsNewDevice();

  console.log("\n==================================================");
  console.log(`TEST SUMMARY: ${passed}/${total} PASSED`);
  if (passed === total) {
    console.log("🎉 ALL ONE-DEVICE POLICY TESTS PASSED!");
  } else {
    console.log(`⚠️  ${total - passed} TESTS FAILED`);
  }
  console.log("==================================================\n");

  await prisma.$disconnect();
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  prisma.$disconnect();
  process.exit(1);
});

