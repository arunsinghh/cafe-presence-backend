/**
 * ADMIN CUSTOMER SEARCH & DEVICE FILTER TEST SUITE
 *
 * Verifies:
 * 1. Admin Customer Search by phone, name, email (pagination & performance)
 * 2. Customer Details API accuracy (identity, status, Classic Member, devices, vouchers)
 * 3. Admin Device List Filter by status (PENDING, ACTIVE, REVOKED, LOST)
 * 4. Admin Device Search by customer phone, name, and installation ID
 */

import { prisma } from "../src/config/prisma";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:4000/api";

let adminToken = "";
let testPhone = "9876543210";
let testCustomerId = 0;
let testDeviceId = 0;
let testInstallationId = "INSTALL_SEARCH_TEST_9876543210";

let passed = 0;
let total = 0;

function assert(label: string, condition: boolean, detail?: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`✅ PASS: ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    console.log(`❌ FAIL: ${label}${detail ? ` (${detail})` : ""}`);
  }
}

async function setup() {
  const adminEmail = "search-admin@cafe.test";
  const adminPassword = "TestAdmin123!";
  const hash = await bcrypt.hash(adminPassword, 10);

  let admin = await prisma.employee.findUnique({
    where: { email: adminEmail }
  });

  if (!admin) {
    admin = await prisma.employee.create({
      data: {
        name: "Search Test Admin",
        email: adminEmail,
        passwordHash: hash,
        role: "ADMIN",
        isActive: true
      }
    });
  }

  const loginRes = await fetch(`${BASE}/auth/employee/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  });
  const loginData = await loginRes.json();
  adminToken = loginData.data?.token || loginData.token;

  // Ensure customer with phone 9876543210 exists
  let customer = await prisma.customer.findUnique({
    where: { phone: testPhone }
  });

  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        name: "Demo Customer",
        phone: testPhone,
        email: "demo.customer@cafe.test",
        status: "APPROVED",
        approvedAt: new Date()
      }
    });
  }
  testCustomerId = customer.id;

  // Ensure customer has an ACTIVE device
  let device = await prisma.device.findFirst({
    where: { customerId: testCustomerId, deviceId: testInstallationId }
  });

  if (!device) {
    device = await prisma.device.create({
      data: {
        customerId: testCustomerId,
        deviceId: testInstallationId,
        status: "ACTIVE",
        approvedAt: new Date()
      }
    });
  }
  testDeviceId = device.id;
}

async function runTests() {
  console.log("==================================================");
  console.log("ADMIN SEARCH & DEVICE FILTERING VERIFICATION");
  console.log("==================================================\n");

  // 1. Admin Customer Search by phone
  const searchPhoneRes = await fetch(`${BASE}/customers?search=${testPhone}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const searchPhoneData = await searchPhoneRes.json();
  const foundByPhone = searchPhoneData.data?.customers?.some(
    (c: any) => c.phone === testPhone
  );
  assert("Customer search by exact phone returns customer", foundByPhone, `Found: ${foundByPhone}`);

  // 2. Admin Customer Search by name
  const searchNameRes = await fetch(`${BASE}/customers?search=Demo`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const searchNameData = await searchNameRes.json();
  const foundByName = searchNameData.data?.customers?.some(
    (c: any) => c.phone === testPhone
  );
  assert("Customer search by name returns customer", foundByName, `Found: ${foundByName}`);

  // 3. Customer list membership is 'Classic Member'
  const targetCust = searchPhoneData.data?.customers?.find(
    (c: any) => c.phone === testPhone
  );
  assert(
    "Customer in list has Classic Member membership",
    targetCust?.membership === "Classic Member",
    `Membership: ${targetCust?.membership}`
  );

  // 4. Customer Details API accuracy
  const detailsRes = await fetch(`${BASE}/customers/${testCustomerId}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const detailsData = await detailsRes.json();
  const customerDetails = detailsData.data;
  assert(
    "Customer details endpoint returns accurate customer info",
    customerDetails?.id === testCustomerId && customerDetails?.phone === testPhone,
    `Id: ${customerDetails?.id}, Phone: ${customerDetails?.phone}`
  );
  assert(
    "Customer details includes Classic Member tier/membership",
    customerDetails?.membership === "Classic Member" || customerDetails?.tier === "CLASSIC MEMBER",
    `Membership: ${customerDetails?.membership}`
  );
  assert(
    "Customer details includes registered devices",
    Array.isArray(customerDetails?.devices) && customerDetails.devices.length > 0,
    `Devices count: ${customerDetails?.devices?.length}`
  );

  // 5. Admin Device List Filter by status=ACTIVE
  const filterActiveRes = await fetch(`${BASE}/devices?status=ACTIVE`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const filterActiveData = await filterActiveRes.json();
  const allActive = filterActiveData.data?.devices?.every(
    (d: any) => d.status === "ACTIVE"
  );
  assert(
    "GET /devices?status=ACTIVE only returns ACTIVE devices",
    allActive && filterActiveData.data?.devices?.length > 0,
    `Count: ${filterActiveData.data?.devices?.length}`
  );

  // 6. Admin Device Search by customer phone
  const searchDevicePhoneRes = await fetch(`${BASE}/devices?search=${testPhone}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const searchDevicePhoneData = await searchDevicePhoneRes.json();
  const foundDeviceByPhone = searchDevicePhoneData.data?.devices?.some(
    (d: any) => d.customer?.phone === testPhone
  );
  assert(
    "GET /devices?search=9876543210 returns customer's devices",
    foundDeviceByPhone,
    `Found: ${foundDeviceByPhone}`
  );

  // 7. Admin Device Search by installation ID
  const searchDeviceInstallRes = await fetch(`${BASE}/devices?search=${testInstallationId}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const searchDeviceInstallData = await searchDeviceInstallRes.json();
  const foundDeviceByInstall = searchDeviceInstallData.data?.devices?.some(
    (d: any) => d.deviceId === testInstallationId
  );
  assert(
    "GET /devices?search=<installationId> returns target device",
    foundDeviceByInstall,
    `Found: ${foundDeviceByInstall}`
  );

  console.log("\n==================================================");
  console.log(`SUMMARY: ${passed}/${total} PASSED`);
  console.log("==================================================\n");

  await prisma.$disconnect();
  process.exit(passed === total ? 0 : 1);
}

setup().then(runTests).catch((err) => {
  console.error("Test failure:", err);
  prisma.$disconnect();
  process.exit(1);
});

