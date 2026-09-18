import http from "http";
import bcrypt from "bcryptjs";
import { PrismaClient, Role, Permission, CustomerStatus, DeviceStatus, VoucherStatus, VoucherType, PresenceMethod, PresenceResult } from "@prisma/client";
import app from "../src/app";
import { generateToken } from "../src/utils/jwt";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();
let server: http.Server;
let baseUrl: string;

function generateCustomerToken(customerId: number, deviceId: string): string {
  const secret = process.env.JWT_CUSTOMER_SECRET || "customer-secret-key-for-development-only";
  return jwt.sign({ customerId, deviceId }, secret, { expiresIn: "7d" });
}

async function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}/api`;
      resolve();
    });
  });
}

async function runAudit() {
  console.log("==================================================");
  console.log("RUNNING EXTENDED END-TO-END AUDIT SUITE");
  console.log("==================================================");

  await startServer();

  // 1. Setup entities
  const CAFE_LAT = 28.570468;
  const CAFE_LON = 77.333510;

  await prisma.cafeConfig.upsert({
    where: { id: 1 },
    update: {
      cafeName: "The Secret Brew Cafe",
      latitude: CAFE_LAT,
      longitude: CAFE_LON,
      allowedRadiusMeters: 50,
      isPresenceEnabled: true
    },
    create: {
      id: 1,
      cafeName: "The Secret Brew Cafe",
      latitude: CAFE_LAT,
      longitude: CAFE_LON,
      allowedRadiusMeters: 50,
      isPresenceEnabled: true
    }
  });

  const adminHash = await bcrypt.hash("Admin@123", 10);
  const admin = await prisma.employee.upsert({
    where: { email: "audit_admin@cafe.com" },
    update: { role: Role.ADMIN, isActive: true },
    create: {
      name: "Audit Admin",
      email: "audit_admin@cafe.com",
      passwordHash: adminHash,
      role: Role.ADMIN,
      isActive: true
    }
  });
  const adminToken = generateToken({ id: admin.id, role: admin.role });

  const customer = await prisma.customer.create({
    data: {
      name: "Audit Customer",
      phone: `987${Date.now().toString().slice(-7)}`,
      status: CustomerStatus.APPROVED,
      approvedAt: new Date()
    }
  });

  const device = await prisma.device.create({
    data: {
      customerId: customer.id,
      deviceId: `DEV-AUDIT-${Date.now()}`,
      status: DeviceStatus.ACTIVE,
      approvedAt: new Date()
    }
  });

  const customerToken = generateCustomerToken(customer.id, device.deviceId);

  const voucher = await prisma.voucher.create({
    data: {
      code: `AUDIT-VOUCHER-${Date.now()}`,
      name: "Audit Special Latte",
      type: VoucherType.FREE_ITEM,
      status: VoucherStatus.ACTIVE
    }
  });

  const customerVoucher = await prisma.customerVoucher.create({
    data: {
      customerId: customer.id,
      voucherId: voucher.id,
      status: VoucherStatus.ACTIVE
    }
  });

  // TEST 1: Android config endpoints
  {
    const res1 = await fetch(`${baseUrl}/presence/config`);
    const data1 = await res1.json() as any;
    const res2 = await fetch(`${baseUrl}/config`);
    const data2 = await res2.json() as any;
    const ok = res1.status === 200 && data1.data?.latitude === CAFE_LAT &&
               res2.status === 200 && data2.data?.allowedRadiusMeters === 50;
    console.log(ok ? "✅ PASS" : "❌ FAIL", "[Audit 1]: /presence/config & /config public endpoints return cafe config");
  }

  // TEST 2: Android initiates redemption session via POST /vouchers/:id/redeem
  let sessionToken = "";
  let sessionId: number | string = "";
  {
    const res = await fetch(`${baseUrl}/vouchers/${voucher.id}/redeem`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({
        latitude: CAFE_LAT,
        longitude: CAFE_LON
      })
    });
    const body = await res.json() as any;
    sessionId = body.data?.sessionId;
    sessionToken = body.data?.sessionToken || body.data?.qrToken;
    const ok = res.status === 201 && !!sessionToken && !!sessionId;
    console.log(ok ? "✅ PASS" : "❌ FAIL", "[Audit 2]: Android POST /vouchers/:id/redeem creates redemption session with qrToken");
  }

  // TEST 3: Android polls session status via GET /vouchers/redemption-session/:sessionId
  {
    const res = await fetch(`${baseUrl}/vouchers/redemption-session/${sessionId}`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    const body = await res.json() as any;
    const ok = res.status === 200 && body.data?.status === "CREATED";
    console.log(ok ? "✅ PASS" : "❌ FAIL", "[Audit 3]: Android GET /vouchers/redemption-session/:sessionId returns session status");
  }

  // TEST 4: Admin Web Panel scans QR via POST /redemption/scan with JSON payload
  // Simulating camera scanner sending stringified JSON: '{"token":"..."}'
  let generatedOtp = "";
  {
    const res = await fetch(`${baseUrl}/redemption/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        token: JSON.stringify({ token: sessionToken })
      })
    });
    const body = await res.json() as any;
    generatedOtp = body._debugOtp || body.data?._debugOtp;
    const ok = res.status === 200 && body.data?.valid === true && body.data?.status === "SCANNED";
    console.log(ok ? "✅ PASS" : "❌ FAIL", "[Audit 4]: Admin scans QR wrapped in stringified JSON object", `(Status: ${body.data?.status})`);
  }

  // TEST 5: Verify customer sees OTP via GET /redemption/session/:token
  {
    const res = await fetch(`${baseUrl}/redemption/session/${sessionToken}`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    const body = await res.json() as any;
    if (!generatedOtp && body.data?.otp) {
      generatedOtp = body.data.otp;
    }
    const ok = res.status === 200 && body.data?.status === "SCANNED" && !!generatedOtp;
    console.log(ok ? "✅ PASS" : "❌ FAIL", "[Audit 5]: Customer receives OTP on mobile app", `(OTP: ${generatedOtp})`);
  }

  // TEST 6: Admin verifies OTP via POST /redemption/verify-otp
  {
    const res = await fetch(`${baseUrl}/redemption/verify-otp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        token: sessionToken,
        otp: generatedOtp
      })
    });
    const body = await res.json() as any;
    const ok = res.status === 200 && body.success === true;
    console.log(ok ? "✅ PASS" : "❌ FAIL", "[Audit 6]: Admin verifies OTP and completes redemption");
  }

  // TEST 7: Customer Profile PATCH /customers/profile/me
  {
    const res = await fetch(`${baseUrl}/customers/profile/me`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({
        name: "Updated Audit Customer"
      })
    });
    const body = await res.json() as any;
    const ok = res.status === 200 && body.data?.name === "Updated Audit Customer" && body.data?.tier === "CLASSIC MEMBER";
    console.log(ok ? "✅ PASS" : "❌ FAIL", "[Audit 7]: Customer updates profile via PATCH /customers/profile/me");
  }

  // TEST 8: Purchases APIs (Android & Employee)
  {
    // Employee records purchase
    const createRes = await fetch(`${baseUrl}/purchases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        customerId: customer.id,
        amount: 250.00,
        description: "Espresso & Croissant"
      })
    });
    const createBody = await createRes.json() as any;

    // Customer views purchases
    const custRes = await fetch(`${baseUrl}/purchases`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    const custBody = await custRes.json() as any;

    const ok = createRes.status === 201 &&
               custRes.status === 200 &&
               Array.isArray(custBody.data?.purchases) &&
               custBody.data.purchases.length > 0;
    console.log(ok ? "✅ PASS" : "❌ FAIL", "[Audit 8]: Purchases recording and retrieval for customer and staff");
  }

  // TEST 9: Admin Audit Logs GET /employees/audit-logs
  {
    const res = await fetch(`${baseUrl}/employees/audit-logs?limit=10`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const body = await res.json() as any;
    const ok = res.status === 200 && Array.isArray(body.data?.logs) && body.data.logs.length > 0;
    console.log(ok ? "✅ PASS" : "❌ FAIL", "[Audit 9]: Admin Web Panel loads Audit Logs (/employees/audit-logs)");
  }

  // TEST 10: Admin Voucher Creation POST /vouchers/create and POST /vouchers
  {
    const code1 = `VC-CREATE-${Date.now()}`;
    const res1 = await fetch(`${baseUrl}/vouchers/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        code: code1,
        name: "Create Test Voucher",
        type: VoucherType.PERCENTAGE,
        value: 15
      })
    });

    const code2 = `VC-POST-${Date.now()}`;
    const res2 = await fetch(`${baseUrl}/vouchers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        code: code2,
        name: "Standard Post Voucher",
        type: VoucherType.FIXED_AMOUNT,
        value: 50
      })
    });

    const ok = res1.status === 201 && res2.status === 201;
    console.log(ok ? "✅ PASS" : "❌ FAIL", "[Audit 10]: Both /vouchers/create and /vouchers create vouchers successfully");
  }

  console.log("==================================================");
  console.log("AUDIT SUITE EXECUTION COMPLETED");
  console.log("==================================================");

  server.close();
  await prisma.$disconnect();
}

runAudit().catch((err) => {
  console.error("Audit Suite Failed:", err);
  if (server) server.close();
  prisma.$disconnect();
  process.exit(1);
});
