import http from "http";
import { PrismaClient, Role, Permission, CustomerStatus, DeviceStatus, VoucherStatus, VoucherType } from "@prisma/client";
import app from "../src/app";
import { generateToken } from "../src/utils/jwt";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();

let server: http.Server;
let baseUrl: string;

async function setupTestServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}/api`;
      resolve();
    });
  });
}

function record(name: string, passed: boolean, details?: string) {
  const status = passed ? "✅ PASS" : "❌ FAIL";
  console.log(`${status}: ${name} ${details ? `(${details})` : ""}`);
  if (!passed) {
    throw new Error(`Test failed: ${name}`);
  }
}

async function run() {
  console.log("==================================================");
  console.log("STARTING TEST SUITE: VOUCHERS, IMAGES & BENEFITS");
  console.log("==================================================");

  await setupTestServer();

  // Create admin employee for admin operations
  const admin = await prisma.employee.upsert({
    where: { email: "admin-vib-test@cafe.com" },
    update: { role: Role.ADMIN },
    create: {
      name: "Admin Vib Test",
      email: "admin-vib-test@cafe.com",
      passwordHash: "hash",
      role: Role.ADMIN
    }
  });

  const adminToken = generateToken({
    id: admin.id,
    role: admin.role
  });

  // Find or create customer with phone 9876543210
  let customer = await prisma.customer.findUnique({
    where: { phone: "9876543210" },
    include: { devices: true }
  });

  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        name: "Demo Customer",
        phone: "9876543210",
        status: CustomerStatus.APPROVED,
        approvedAt: new Date()
      },
      include: { devices: true }
    });
  }

  let device = customer.devices.find((d) => d.status === DeviceStatus.ACTIVE);
  if (!device) {
    device = await prisma.device.create({
      data: {
        customerId: customer.id,
        deviceId: "test-device-uuid-9876",
        deviceName: "Pixel 7 Pro",
        platform: "Android",
        status: DeviceStatus.ACTIVE,
        approvedAt: new Date()
      }
    });
  }

  const customerToken = generateToken({
    customerId: customer.id,
    deviceId: device.deviceId
  });

  // 1. Ensure customer has at least one active voucher
  let activeTemplate = await prisma.voucher.findFirst({
    where: { status: VoucherStatus.ACTIVE }
  });

  if (!activeTemplate) {
    activeTemplate = await prisma.voucher.create({
      data: {
        code: `TEST-ACT-${Date.now()}`,
        name: "Free Cold Brew Test",
        type: VoucherType.FREE_ITEM,
        value: null, // Test null value serialization!
        status: VoucherStatus.ACTIVE
      }
    });
  }

  const existingAssignment = await prisma.customerVoucher.findFirst({
    where: { customerId: customer.id, voucherId: activeTemplate.id, status: VoucherStatus.ACTIVE }
  });

  if (!existingAssignment) {
    await prisma.customerVoucher.create({
      data: {
        customerId: customer.id,
        voucherId: activeTemplate.id,
        status: VoucherStatus.ACTIVE
      }
    });
  }

  // TEST 1: Customer fetches vouchers via GET /vouchers
  const res1 = await fetch(`${baseUrl}/vouchers`, {
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  const data1 = (await res1.json()) as any;
  record(
    "Customer fetches vouchers from GET /vouchers",
    res1.status === 200 && Array.isArray(data1.vouchers) && data1.vouchers.length > 0,
    `Voucher count: ${data1.vouchers?.length}`
  );

  // TEST 2: Verify voucher fields are compatible with Android Kotlin models (value & minSpend are numbers, not null)
  const firstVoucher = data1.vouchers[0];
  const isValidAndroidContract =
    typeof firstVoucher.id === "number" &&
    typeof firstVoucher.value === "number" &&
    typeof firstVoucher.discount === "number" &&
    typeof firstVoucher.minSpend === "number" &&
    firstVoucher.value !== null &&
    firstVoucher.minSpend !== null &&
    typeof firstVoucher.title === "string" &&
    typeof firstVoucher.status === "string";

  record(
    "Voucher fields match Android non-null Double schema (no null value / minSpend)",
    isValidAndroidContract,
    `value: ${firstVoucher.value}, minSpend: ${firstVoucher.minSpend}, title: ${firstVoucher.title}`
  );

  // TEST 3: Customer profile endpoint returns real points, membership, active vouchers & benefits
  const resProfile = await fetch(`${baseUrl}/customers/profile/me`, {
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  const dataProfile = (await resProfile.json()) as any;
  record(
    "Customer profile returns CLASSIC MEMBER, active vouchers, and benefits",
    resProfile.status === 200 &&
      dataProfile.customer?.tier === "CLASSIC MEMBER" &&
      Array.isArray(dataProfile.customer?.activeVouchers) &&
      Array.isArray(dataProfile.customer?.benefits),
    `Tier: ${dataProfile.customer?.tier}, Active Vouchers: ${dataProfile.customer?.activeVouchers?.length}, Benefits: ${dataProfile.customer?.benefits?.length}`
  );

  // TEST 4: Benefits endpoint GET /benefits returns default seeded benefits
  const resBenefits = await fetch(`${baseUrl}/benefits`);
  const dataBenefits = (await resBenefits.json()) as any;
  record(
    "GET /benefits returns active seeded benefits",
    resBenefits.status === 200 && Array.isArray(dataBenefits.benefits) && dataBenefits.benefits.length >= 3,
    `Count: ${dataBenefits.benefits?.length}, First: ${dataBenefits.benefits?.[0]?.title}`
  );

  // TEST 5: Image upload with valid JPEG magic bytes
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const boundary = "----WebKitFormBoundaryTest12345";
  let body = `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="image"; filename="coffee.jpg"\r\n`;
  body += `Content-Type: image/jpeg\r\n\r\n`;
  const part1 = Buffer.from(body, "utf-8");
  const part3 = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
  const multipartBody = Buffer.concat([part1, jpegHeader, part3]);

  const resUpload = await fetch(`${baseUrl}/vouchers/upload-image`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    },
    body: multipartBody
  });
  const dataUpload = (await resUpload.json()) as any;
  record(
    "Admin uploads valid JPEG voucher image (magic bytes verified)",
    resUpload.status === 201 && typeof dataUpload.data?.imageUrl === "string" && dataUpload.data.imageUrl.startsWith("/uploads/vouchers/"),
    `Uploaded path: ${dataUpload.data?.imageUrl}`
  );

  const uploadedImageUrl = dataUpload.data?.imageUrl;

  // TEST 6: Upload fake image (text disguised as .jpg) -> Magic byte check rejects it
  const fakeBody = `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="fake.jpg"\r\nContent-Type: image/jpeg\r\n\r\nThis is plain text disguised as jpg\r\n--${boundary}--\r\n`;
  const resFake = await fetch(`${baseUrl}/vouchers/upload-image`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    },
    body: Buffer.from(fakeBody, "utf-8")
  });
  record(
    "Fake image upload rejected due to invalid magic bytes",
    resFake.status === 400 || resFake.status === 500,
    `Status: ${resFake.status}`
  );

  // TEST 7: Update voucher image via POST /vouchers/:id/image
  const resVoucherImage = await fetch(`${baseUrl}/vouchers/${activeTemplate.id}/image`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    },
    body: multipartBody
  });
  const dataVoucherImage = (await resVoucherImage.json()) as any;
  record(
    "POST /vouchers/:id/image attaches image to voucher",
    resVoucherImage.status === 200 && dataVoucherImage.data?.imageUrl !== null,
    `imageUrl: ${dataVoucherImage.data?.imageUrl}`
  );

  // TEST 8: Customer views voucher and sees imageUrl
  const resCustomerVoucher = await fetch(`${baseUrl}/vouchers/${activeTemplate.id}`, {
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  const dataCustomerVoucher = (await resCustomerVoucher.json()) as any;
  record(
    "Customer voucher details return updated imageUrl",
    resCustomerVoucher.status === 200 && typeof dataCustomerVoucher.data?.imageUrl === "string",
    `imageUrl: ${dataCustomerVoucher.data?.imageUrl}`
  );

  // TEST 9: DELETE /vouchers/:id/image removes image
  const resDeleteImage = await fetch(`${baseUrl}/vouchers/${activeTemplate.id}/image`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const dataDeleteImage = (await resDeleteImage.json()) as any;
  record(
    "DELETE /vouchers/:id/image removes image",
    resDeleteImage.status === 200 && dataDeleteImage.data?.imageUrl === null,
    `imageUrl after delete: ${dataDeleteImage.data?.imageUrl}`
  );

  // TEST 10: Admin creates a new Benefit via POST /benefits
  const resCreateBenefit = await fetch(`${baseUrl}/benefits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: "Free Birthday Cake",
      description: "Celebrate your birthday with complimentary dessert",
      displayOrder: 4,
      active: true
    })
  });
  const dataCreateBenefit = (await resCreateBenefit.json()) as any;
  record(
    "Admin creates new Benefit via POST /benefits",
    resCreateBenefit.status === 201 && dataCreateBenefit.data?.title === "Free Birthday Cake",
    `Created benefit ID: ${dataCreateBenefit.data?.id}`
  );

  const newBenefitId = dataCreateBenefit.data?.id;

  // TEST 11: Admin updates Benefit via PATCH /benefits/:id
  const resPatchBenefit = await fetch(`${baseUrl}/benefits/${newBenefitId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: "Free Birthday Pastry"
    })
  });
  const dataPatchBenefit = (await resPatchBenefit.json()) as any;
  record(
    "Admin updates Benefit via PATCH /benefits/:id",
    resPatchBenefit.status === 200 && dataPatchBenefit.data?.title === "Free Birthday Pastry",
    `Updated title: ${dataPatchBenefit.data?.title}`
  );

  // TEST 12: Admin deletes Benefit via DELETE /benefits/:id
  const resDeleteBenefit = await fetch(`${baseUrl}/benefits/${newBenefitId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  record(
    "Admin deletes Benefit via DELETE /benefits/:id",
    resDeleteBenefit.status === 200,
    `Status: ${resDeleteBenefit.status}`
  );

  console.log("==================================================");
  console.log("🎉 ALL TESTS PASSED SUCCESSFULLY!");
  console.log("==================================================");

  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

run().catch(async (e) => {
  console.error("Test execution failed:", e);
  if (server) server.close();
  await prisma.$disconnect();
  process.exit(1);
});
