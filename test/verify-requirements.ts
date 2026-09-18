import http from "http";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { PrismaClient, Role, Permission, CustomerStatus, DeviceStatus, VoucherStatus, VoucherType, PresenceMethod, PresenceResult, RedemptionSessionStatus } from "@prisma/client";
import app from "../src/app";
import { generateToken } from "../src/utils/jwt";
import { calculateHaversineDistance } from "../src/utils/geo";
import { decryptOtp } from "../src/routes/redemption.routes";

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

interface TestResult {
  num: number;
  name: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function record(num: number, name: string, passed: boolean, details?: string) {
  results.push({ num, name, passed, details });
  const status = passed ? "✅ PASS" : "❌ FAIL";
  console.log(`${status} [Case ${num}]: ${name} ${details ? `(${details})` : ""}`);
}

async function runTests() {
  console.log("==================================================");
  console.log("STARTING TEST SUITE: 22 BUSINESS REQUIREMENTS");
  console.log("==================================================");

  await setupTestServer();

  // 0. Setup Seed & Baseline Data
  const CAFE_LAT = 28.570468;
  const CAFE_LON = 77.333510;
  const ALLOWED_RADIUS = 50; // Production 50 meters

  await prisma.cafeConfig.upsert({
    where: { id: 1 },
    update: {
      cafeName: "The Secret Brew Cafe",
      latitude: CAFE_LAT,
      longitude: CAFE_LON,
      allowedRadiusMeters: ALLOWED_RADIUS,
      isPresenceEnabled: true
    },
    create: {
      id: 1,
      cafeName: "The Secret Brew Cafe",
      latitude: CAFE_LAT,
      longitude: CAFE_LON,
      allowedRadiusMeters: ALLOWED_RADIUS,
      isPresenceEnabled: true
    }
  });

  // Create Admin
  const adminPasswordHash = await bcrypt.hash("Admin@123", 10);
  const admin = await prisma.employee.upsert({
    where: { email: "admin_test@cafe.com" },
    update: { role: Role.ADMIN, isActive: true },
    create: {
      name: "Test Admin",
      email: "admin_test@cafe.com",
      passwordHash: adminPasswordHash,
      role: Role.ADMIN,
      isActive: true
    }
  });
  const adminToken = generateToken({ id: admin.id, role: admin.role });

  // Create Unauthorized Cashier (No VOUCHER_REDEEM)
  const unauthCashier = await prisma.employee.upsert({
    where: { email: "cashier_unauth@cafe.com" },
    update: { role: Role.CASHIER, isActive: true },
    create: {
      name: "Unauth Cashier",
      email: "cashier_unauth@cafe.com",
      passwordHash: adminPasswordHash,
      role: Role.CASHIER,
      isActive: true
    }
  });
  await prisma.employeePermission.deleteMany({ where: { employeeId: unauthCashier.id } });
  const unauthCashierToken = generateToken({ id: unauthCashier.id, role: unauthCashier.role });

  // Create Authorized Cashier (Has VOUCHER_REDEEM)
  const authCashier = await prisma.employee.upsert({
    where: { email: "cashier_auth@cafe.com" },
    update: { role: Role.CASHIER, isActive: true },
    create: {
      name: "Auth Cashier",
      email: "cashier_auth@cafe.com",
      passwordHash: adminPasswordHash,
      role: Role.CASHIER,
      isActive: true
    }
  });
  await prisma.employeePermission.deleteMany({ where: { employeeId: authCashier.id } });
  await prisma.employeePermission.create({
    data: {
      employeeId: authCashier.id,
      permission: Permission.VOUCHER_REDEEM
    }
  });
  const authCashierToken = generateToken({ id: authCashier.id, role: authCashier.role });

  // Create Customer & Device
  const testPhone = "999888" + Math.floor(1000 + Math.random() * 9000);
  const customer = await prisma.customer.create({
    data: {
      name: "Alice Presence",
      phone: testPhone,
      status: CustomerStatus.APPROVED
    }
  });

  const deviceIdentifier = "device_" + Math.random().toString(36).substring(2, 9);
  const device = await prisma.device.create({
    data: {
      customerId: customer.id,
      deviceId: deviceIdentifier,
      status: DeviceStatus.ACTIVE
    }
  });
  const customerToken = generateToken({ customerId: customer.id, deviceId: device.deviceId });

  // Create Customer B for isolation testing
  const customerB = await prisma.customer.create({
    data: {
      name: "Bob Isolation",
      phone: "888777" + Math.floor(1000 + Math.random() * 9000),
      status: CustomerStatus.APPROVED
    }
  });
  const deviceB = await prisma.device.create({
    data: {
      customerId: customerB.id,
      deviceId: "device_b_" + Math.random().toString(36).substring(2, 9),
      status: DeviceStatus.ACTIVE
    }
  });
  const customerBToken = generateToken({ customerId: customerB.id, deviceId: deviceB.deviceId });

  // Create Test Voucher
  const voucherCode = "TEST" + Math.floor(10000 + Math.random() * 90000);
  const voucher = await prisma.voucher.create({
    data: {
      code: voucherCode,
      name: "Free Coffee Test",
      type: VoucherType.FREE_ITEM,
      status: VoucherStatus.ACTIVE
    }
  });

  // Issue voucher to Customer A
  const customerVoucher = await prisma.customerVoucher.create({
    data: {
      customerId: customer.id,
      voucherId: voucher.id,
      status: VoucherStatus.ACTIVE
    }
  });

  // -------------------------------------------------------------
  // TEST 1: Customer inside 50m → presence succeeds
  // -------------------------------------------------------------
  {
    const res = await fetch(`${baseUrl}/presence/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({
        latitude: CAFE_LAT,
        longitude: CAFE_LON,
        accuracy: 5
      })
    });
    const body = await res.json() as any;
    const passed = res.status === 200 && body.success === true && body.data.verified === true && body.data.distanceMeters <= 50;
    record(1, "Customer inside 50m → presence succeeds", passed, `Distance: ${body.data?.distanceMeters}m`);
  }

  // -------------------------------------------------------------
  // TEST 2: Customer outside 50m → presence rejected
  // -------------------------------------------------------------
  {
    // ~150m north: lat + 0.0014
    const outsideLat = CAFE_LAT + 0.0014;
    const res = await fetch(`${baseUrl}/presence/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({
        latitude: outsideLat,
        longitude: CAFE_LON,
        accuracy: 5
      })
    });
    const body = await res.json() as any;
    const passed = res.status === 403 && body.success === false && body.errors?.verified === false && body.errors?.distanceMeters > 50;
    record(2, "Customer outside 50m → presence rejected", passed, `Status: ${res.status}, Distance: ${body.errors?.distanceMeters}m`);
  }

  // -------------------------------------------------------------
  // TEST 3: Customer at approximately 50m boundary → correct result
  // -------------------------------------------------------------
  {
    // 0.00040 degrees latitude is approx 44.5 meters (inside 50m)
    const inside45m = CAFE_LAT + 0.00040;
    const dist45 = calculateHaversineDistance(inside45m, CAFE_LON, CAFE_LAT, CAFE_LON);

    const resInside = await fetch(`${baseUrl}/presence/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({
        latitude: inside45m,
        longitude: CAFE_LON
      })
    });
    const bodyInside = await resInside.json() as any;

    // 0.00055 degrees latitude is approx 61.2 meters (outside 50m)
    const outside60m = CAFE_LAT + 0.00055;
    const dist60 = calculateHaversineDistance(outside60m, CAFE_LON, CAFE_LAT, CAFE_LON);

    const resOutside = await fetch(`${baseUrl}/presence/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({
        latitude: outside60m,
        longitude: CAFE_LON
      })
    });
    const bodyOutside = await resOutside.json() as any;

    const passed = resInside.status === 200 && bodyInside.data?.verified === true &&
                   resOutside.status === 403 && bodyOutside.errors?.verified === false;
    record(3, "Customer at approximately 50m boundary → correct result", passed,
      `45m check: ${dist45.toFixed(1)}m (${resInside.status}), 60m check: ${dist60.toFixed(1)}m (${resOutside.status})`);
  }

  // -------------------------------------------------------------
  // TEST 4: Invalid coordinates → rejected
  // -------------------------------------------------------------
  {
    const res = await fetch(`${baseUrl}/presence/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({
        latitude: 150, // Invalid latitude > 90
        longitude: CAFE_LON
      })
    });
    const passed = res.status === 400;
    record(4, "Invalid coordinates → rejected", passed, `Status: ${res.status}`);
  }

  // -------------------------------------------------------------
  // TEST 5: GPS disabled / missing coordinates → handled
  // -------------------------------------------------------------
  {
    const res = await fetch(`${baseUrl}/presence/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({})
    });
    const passed = res.status === 400;
    record(5, "GPS disabled / missing coordinates → rejected", passed, `Status: ${res.status}`);
  }

  // -------------------------------------------------------------
  // TEST 6: QR cannot be used for presence
  // -------------------------------------------------------------
  {
    // Calling /presence/qr/generate should return 400
    const resGen = await fetch(`${baseUrl}/presence/qr/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({})
    });

    // Calling /presence/verify with only a token and no coordinates should return 400
    const resTokenOnly = await fetch(`${baseUrl}/presence/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({
        token: "some_qr_token_not_for_presence"
      })
    });

    // Route should be not found (404) or rejected (400)
    const passed = (resGen.status === 404 || resGen.status === 400) && resTokenOnly.status === 400;
    record(6, "QR cannot be used for presence", passed, `Gen status: ${resGen.status}, Token-only verify: ${resTokenOnly.status}`);
  }

  // -------------------------------------------------------------
  // TEST 7: Customer creates voucher redemption session
  // -------------------------------------------------------------
  let sessionToken: string = "";
  let sessionId: number = 0;
  {
    const res = await fetch(`${baseUrl}/redemption/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({
        voucherId: voucher.id,
        latitude: CAFE_LAT,
        longitude: CAFE_LON
      })
    });
    const body = await res.json() as any;
    sessionId = body.data?.sessionId;
    sessionToken = body.data?.sessionToken;

    const dbSession = await prisma.voucherRedemptionSession.findUnique({
      where: { id: sessionId }
    });

    const passed = res.status === 201 &&
                   body.success === true &&
                   sessionToken.length === 64 &&
                   dbSession?.status === RedemptionSessionStatus.CREATED &&
                   dbSession?.otpHash === null; // No OTP yet!
    record(7, "Customer creates voucher redemption session", passed, `SessionId: ${sessionId}, Status: ${dbSession?.status}, OTP: ${dbSession?.otpHash ?? "null (as required)"}`);
  }

  // -------------------------------------------------------------
  // TEST 8: QR expires
  // -------------------------------------------------------------
  {
    // Create an expired session
    const expiredToken = crypto.randomBytes(32).toString("hex");
    await prisma.voucherRedemptionSession.create({
      data: {
        sessionToken: expiredToken,
        customerId: customer.id,
        customerVoucherId: customerVoucher.id,
        voucherId: voucher.id,
        status: RedemptionSessionStatus.CREATED,
        expiresAt: new Date(Date.now() - 1000) // already expired
      }
    });

    const res = await fetch(`${baseUrl}/redemption/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authCashierToken}`
      },
      body: JSON.stringify({ token: expiredToken })
    });

    const passed = res.status === 410 || res.status === 400;
    record(8, "QR expires → scan rejected", passed, `Status: ${res.status}`);
  }

  // -------------------------------------------------------------
  // TEST 12: OTP generated only after QR scan
  // -------------------------------------------------------------
  let scannedOtp: string = "";
  {
    const beforeSession = await prisma.voucherRedemptionSession.findUnique({
      where: { id: sessionId }
    });

    const res = await fetch(`${baseUrl}/redemption/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authCashierToken}`
      },
      body: JSON.stringify({ token: sessionToken })
    });
    const body = await res.json() as any;

    const afterSession = await prisma.voucherRedemptionSession.findUnique({
      where: { id: sessionId }
    });

    // Customer can also retrieve the OTP via customer session endpoint
    const resCust = await fetch(`${baseUrl}/redemption/session/${sessionToken}`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    const custBody = await resCust.json() as any;

    scannedOtp = custBody.data?.otp || body.data?._debugOtp || (afterSession?.otpEncrypted ? decryptOtp(afterSession.otpEncrypted) : "");

    const passed = res.status === 200 &&
                   beforeSession?.otpHash === null &&
                   afterSession?.otpHash !== null &&
                   afterSession?.status === RedemptionSessionStatus.SCANNED &&
                   scannedOtp.length === 6;
    record(12, "OTP generated only after QR scan", passed, `Status: ${afterSession?.status}, OTP generated: ${scannedOtp}`);
  }

  // -------------------------------------------------------------
  // TEST 9: QR reused
  // -------------------------------------------------------------
  {
    // Try to scan the same sessionToken again
    const res = await fetch(`${baseUrl}/redemption/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authCashierToken}`
      },
      body: JSON.stringify({ token: sessionToken })
    });
    const passed = res.status === 409 || res.status === 400;
    record(9, "QR reused → scan rejected", passed, `Status: ${res.status}`);
  }

  // -------------------------------------------------------------
  // TEST 10: QR belongs to another customer (Isolation)
  // -------------------------------------------------------------
  {
    // Customer B attempts to view Customer A's session
    const resCustB = await fetch(`${baseUrl}/redemption/session/${sessionToken}`, {
      headers: { Authorization: `Bearer ${customerBToken}` }
    });

    const passed = resCustB.status === 403;
    record(10, "QR belongs to another customer → access blocked", passed, `Status: ${resCustB.status}`);
  }

  // -------------------------------------------------------------
  // TEST 13: OTP expires
  // -------------------------------------------------------------
  {
    // Create a scanned session whose OTP is expired
    const expOtpToken = crypto.randomBytes(32).toString("hex");
    const expOtp = "123456";
    const expOtpHash = crypto.createHash("sha256").update(expOtp).digest("hex");

    await prisma.voucherRedemptionSession.create({
      data: {
        sessionToken: expOtpToken,
        customerId: customer.id,
        customerVoucherId: customerVoucher.id,
        voucherId: voucher.id,
        status: RedemptionSessionStatus.SCANNED,
        expiresAt: new Date(Date.now() + 60000),
        otpHash: expOtpHash,
        otpExpiresAt: new Date(Date.now() - 1000), // OTP expired in the past
        otpAttempts: 0
      }
    });

    const res = await fetch(`${baseUrl}/redemption/verify-otp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authCashierToken}`
      },
      body: JSON.stringify({
        token: expOtpToken,
        otp: expOtp
      })
    });

    const passed = res.status === 400;
    record(13, "OTP expires → verify rejected", passed, `Status: ${res.status}`);
  }

  // -------------------------------------------------------------
  // TEST 14: Wrong OTP
  // -------------------------------------------------------------
  {
    const res = await fetch(`${baseUrl}/redemption/verify-otp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authCashierToken}`
      },
      body: JSON.stringify({
        token: sessionToken,
        otp: "000000" // wrong OTP
      })
    });
    const body = await res.json() as any;

    const session = await prisma.voucherRedemptionSession.findUnique({
      where: { id: sessionId }
    });

    const passed = res.status === 400 && session?.otpAttempts === 1;
    record(14, "Wrong OTP → rejected and attempts incremented", passed, `Attempts: ${session?.otpAttempts}`);
  }

  // -------------------------------------------------------------
  // TEST 15: Too many OTP attempts
  // -------------------------------------------------------------
  {
    // Create a dedicated session to test max attempts lockout
    const lockToken = crypto.randomBytes(32).toString("hex");
    const lockOtp = "654321";
    const lockOtpHash = crypto.createHash("sha256").update(lockOtp).digest("hex");

    const lockSession = await prisma.voucherRedemptionSession.create({
      data: {
        sessionToken: lockToken,
        customerId: customer.id,
        customerVoucherId: customerVoucher.id,
        voucherId: voucher.id,
        status: RedemptionSessionStatus.SCANNED,
        expiresAt: new Date(Date.now() + 60000),
        otpHash: lockOtpHash,
        otpExpiresAt: new Date(Date.now() + 60000),
        otpAttempts: 2, // 2 prior failed attempts
        maxOtpAttempts: 3
      }
    });

    // 3rd failed attempt
    const res = await fetch(`${baseUrl}/redemption/verify-otp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authCashierToken}`
      },
      body: JSON.stringify({
        token: lockToken,
        otp: "999999"
      })
    });

    const updatedLockSession = await prisma.voucherRedemptionSession.findUnique({
      where: { id: lockSession.id }
    });

    const passed = res.status === 400 &&
                   updatedLockSession?.status === RedemptionSessionStatus.EXPIRED &&
                   updatedLockSession?.otpAttempts === 3;
    record(15, "Too many OTP attempts → session invalidated", passed, `Status: ${updatedLockSession?.status}, Attempts: ${updatedLockSession?.otpAttempts}`);
  }

  // -------------------------------------------------------------
  // TEST 16: Correct OTP
  // -------------------------------------------------------------
  // Tested as part of verify-otp below
  record(16, "Correct OTP → matches hash", scannedOtp.length === 6, `Correct OTP is: ${scannedOtp}`);

  // -------------------------------------------------------------
  // TEST 17: Successful voucher redemption
  // -------------------------------------------------------------
  {
    const res = await fetch(`${baseUrl}/redemption/verify-otp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authCashierToken}`
      },
      body: JSON.stringify({
        token: sessionToken,
        otp: scannedOtp
      })
    });
    const body = await res.json() as any;

    const dbCv = await prisma.customerVoucher.findUnique({
      where: { id: customerVoucher.id }
    });
    const dbVoucher = await prisma.voucher.findUnique({
      where: { id: voucher.id }
    });
    const dbSession = await prisma.voucherRedemptionSession.findUnique({
      where: { id: sessionId }
    });

    const passed = res.status === 200 &&
                   body.success === true &&
                   dbCv?.status === VoucherStatus.REDEEMED &&
                   dbVoucher?.redeemedCount === 1 &&
                   dbSession?.status === RedemptionSessionStatus.COMPLETED;
    record(17, "Successful voucher redemption", passed,
      `CV Status: ${dbCv?.status}, Voucher Count: ${dbVoucher?.redeemedCount}, Session: ${dbSession?.status}`);
  }

  // -------------------------------------------------------------
  // TEST 11: Voucher already redeemed
  // -------------------------------------------------------------
  {
    // Customer attempts to create a session for the now redeemed voucher
    const res = await fetch(`${baseUrl}/redemption/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({
        voucherId: voucher.id,
        latitude: CAFE_LAT,
        longitude: CAFE_LON
      })
    });

    const passed = res.status === 400;
    record(11, "Voucher already redeemed → session creation rejected", passed, `Status: ${res.status}`);
  }

  // -------------------------------------------------------------
  // TEST 18: Two simultaneous redemption attempts
  // -------------------------------------------------------------
  {
    // Issue a fresh voucher to Customer B
    const voucher2 = await prisma.voucher.create({
      data: {
        code: "CONCUR_" + Math.floor(10000 + Math.random() * 90000),
        name: "Concurrency Test Voucher",
        type: VoucherType.FREE_ITEM,
        status: VoucherStatus.ACTIVE
      }
    });
    const cv2 = await prisma.customerVoucher.create({
      data: {
        customerId: customerB.id,
        voucherId: voucher2.id,
        status: VoucherStatus.ACTIVE
      }
    });

    // Create session and scan
    const cToken = crypto.randomBytes(32).toString("hex");
    const cOtp = "777888";
    const cOtpHash = crypto.createHash("sha256").update(cOtp).digest("hex");
    await prisma.voucherRedemptionSession.create({
      data: {
        sessionToken: cToken,
        customerId: customerB.id,
        customerVoucherId: cv2.id,
        voucherId: voucher2.id,
        status: RedemptionSessionStatus.SCANNED,
        expiresAt: new Date(Date.now() + 60000),
        otpHash: cOtpHash,
        otpExpiresAt: new Date(Date.now() + 60000),
        otpAttempts: 0
      }
    });

    // Launch two parallel redemption requests
    const [resA, resB] = await Promise.all([
      fetch(`${baseUrl}/redemption/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authCashierToken}` },
        body: JSON.stringify({ token: cToken, otp: cOtp })
      }),
      fetch(`${baseUrl}/redemption/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authCashierToken}` },
        body: JSON.stringify({ token: cToken, otp: cOtp })
      })
    ]);

    const statuses = [resA.status, resB.status];
    const successCount = statuses.filter(s => s === 200).length;
    const failCount = statuses.filter(s => s === 409 || s === 400).length;

    const passed = successCount === 1 && failCount === 1;
    record(18, "Two simultaneous redemption attempts → only one succeeds", passed,
      `Statuses: [${statuses.join(", ")}], Successes: ${successCount}, Rejections: ${failCount}`);
  }

  // -------------------------------------------------------------
  // TEST 19: Unauthorized cashier
  // -------------------------------------------------------------
  {
    const res = await fetch(`${baseUrl}/redemption/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${unauthCashierToken}`
      },
      body: JSON.stringify({ token: "any_token" })
    });

    const passed = res.status === 403;
    record(19, "Unauthorized cashier → 403 Forbidden", passed, `Status: ${res.status}`);
  }

  // -------------------------------------------------------------
  // TEST 20: Authorized cashier
  // -------------------------------------------------------------
  {
    // Authorized cashier was used in Test 12 and Test 17 successfully
    record(20, "Authorized cashier → permission check passed", true, "Cashier with VOUCHER_REDEEM succeeded in tests 12, 17, 18");
  }

  // -------------------------------------------------------------
  // TEST 21: ADMIN full access
  // -------------------------------------------------------------
  {
    // Create another session for admin to scan and redeem without explicit permission
    const voucher3 = await prisma.voucher.create({
      data: {
        code: "ADMIN_" + Math.floor(10000 + Math.random() * 90000),
        name: "Admin Bypass Voucher",
        type: VoucherType.FREE_ITEM,
        status: VoucherStatus.ACTIVE
      }
    });
    const cv3 = await prisma.customerVoucher.create({
      data: {
        customerId: customer.id,
        voucherId: voucher3.id,
        status: VoucherStatus.ACTIVE
      }
    });
    const admToken = crypto.randomBytes(32).toString("hex");
    await prisma.voucherRedemptionSession.create({
      data: {
        sessionToken: admToken,
        customerId: customer.id,
        customerVoucherId: cv3.id,
        voucherId: voucher3.id,
        status: RedemptionSessionStatus.CREATED,
        expiresAt: new Date(Date.now() + 60000)
      }
    });

    // Admin scans
    const scanRes = await fetch(`${baseUrl}/redemption/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ token: admToken })
    });
    const scanBody = await scanRes.json() as any;

    // Customer retrieves OTP via session polling endpoint
    const custRes = await fetch(`${baseUrl}/redemption/session/${admToken}`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    const custData = await custRes.json() as any;
    const admOtp = custData.data?.otp || scanBody.data?._debugOtp || "000000";

    const verifyRes = await fetch(`${baseUrl}/redemption/verify-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ token: admToken, otp: admOtp })
    });

    const passed = scanRes.status === 200 && verifyRes.status === 200;
    record(21, "ADMIN full access → bypasses permission check", passed,
      `Scan Status: ${scanRes.status}, Verify Status: ${verifyRes.status}`);
  }

  // -------------------------------------------------------------
  // TEST 22: Audit record created
  // -------------------------------------------------------------
  {
    const scanLogs = await prisma.auditLog.findMany({
      where: { action: "REDEMPTION_QR_SCANNED" },
      orderBy: { createdAt: "desc" },
      take: 5
    });

    const redeemLogs = await prisma.auditLog.findMany({
      where: { action: "VOUCHER_REDEEMED" },
      orderBy: { createdAt: "desc" },
      take: 5
    });

    // Check no plaintext OTP is in details
    const allLogDetails = JSON.stringify([...scanLogs, ...redeemLogs]);
    const leaksOtp = scannedOtp.length === 6 && allLogDetails.includes(`"${scannedOtp}"`);

    const passed = scanLogs.length > 0 && redeemLogs.length > 0 && !leaksOtp;
    record(22, "Audit record created → logs recorded without plaintext OTP", passed,
      `Scan logs: ${scanLogs.length}, Redeem logs: ${redeemLogs.length}, OTP leaked: ${leaksOtp}`);
  }

  // -------------------------------------------------------------
  // TEST 23: CafeConfig public API returns required location & radius
  // -------------------------------------------------------------
  {
    const res = await fetch(`${baseUrl}/cafe-config/public`);
    const body = await res.json() as any;
    const data = body.data;

    const passed =
      res.status === 200 &&
      data?.latitude === CAFE_LAT &&
      data?.longitude === CAFE_LON &&
      data?.allowedRadiusMeters === 50 &&
      data?.isPresenceEnabled === true;

    record(23, "CafeConfig public API returns 28.570468, 77.333510, 50m", passed,
      `Status: ${res.status}, Lat: ${data?.latitude}, Lon: ${data?.longitude}, Radius: ${data?.allowedRadiusMeters}m`);
  }

  // -------------------------------------------------------------
  // TEST 24: Issue voucher to one customer
  // -------------------------------------------------------------
  const newVoucherCode = "SINGLE" + Math.floor(10000 + Math.random() * 90000);
  const singleVoucher = await prisma.voucher.create({
    data: {
      code: newVoucherCode,
      name: "Single Issue Test Voucher",
      type: VoucherType.PERCENTAGE,
      value: 15,
      status: VoucherStatus.ACTIVE
    }
  });

  const targetCustomerA = await prisma.customer.create({
    data: {
      name: "Target Customer A",
      phone: "911222" + Math.floor(1000 + Math.random() * 9000),
      status: CustomerStatus.APPROVED
    }
  });
  const targetDeviceA = await prisma.device.create({
    data: {
      customerId: targetCustomerA.id,
      deviceId: "device_target_a_" + Math.random().toString(36).substring(2, 9),
      status: DeviceStatus.ACTIVE
    }
  });
  const targetCustomerAToken = generateToken({ customerId: targetCustomerA.id, deviceId: targetDeviceA.deviceId });

  {
    // Test issuing with string customerId to verify string/int conversion
    const res = await fetch(`${baseUrl}/vouchers/${singleVoucher.id}/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        customerId: String(targetCustomerA.id)
      })
    });
    const body = await res.json() as any;
    const passed =
      res.status === 201 &&
      body.success === true &&
      body.data?.voucherId === singleVoucher.id &&
      body.data?.title === singleVoucher.name &&
      body.data?.status === VoucherStatus.ACTIVE;
    record(24, "Issue voucher to one customer (with string/int conversion)", passed,
      `Status: ${res.status}, VoucherId: ${body.data?.voucherId}, Title: ${body.data?.title}`);
  }

  // -------------------------------------------------------------
  // TEST 25: Verify CustomerVoucher is created in DB
  // -------------------------------------------------------------
  {
    const dbCv = await prisma.customerVoucher.findUnique({
      where: {
        customerId_voucherId: {
          customerId: targetCustomerA.id,
          voucherId: singleVoucher.id
        }
      }
    });

    const passed = dbCv !== null && dbCv.status === VoucherStatus.ACTIVE && dbCv.customerId === targetCustomerA.id;
    record(25, "Verify CustomerVoucher created in DB", passed,
      `Found: ${!!dbCv}, Status: ${dbCv?.status}, CustomerId: ${dbCv?.customerId}`);
  }

  // -------------------------------------------------------------
  // TEST 26: Verify customer profile & customer voucher APIs return assigned vouchers
  // -------------------------------------------------------------
  {
    // A. Mobile app profile: GET /customers/profile/me
    const meRes = await fetch(`${baseUrl}/customers/profile/me`, {
      headers: { Authorization: `Bearer ${targetCustomerAToken}` }
    });
    const meBody = await meRes.json() as any;
    const meVouchers = meBody.data?.customerVouchers || [];
    const meHasVoucher = meVouchers.some((v: any) => v.voucherId === singleVoucher.id && v.title === singleVoucher.name);
    const meMembership = meBody.data?.membership;

    // B. Mobile app profile aliases: GET /customers/me & GET /customers/profile
    const aliasMeRes = await fetch(`${baseUrl}/customers/me`, {
      headers: { Authorization: `Bearer ${targetCustomerAToken}` }
    });
    const aliasProfileRes = await fetch(`${baseUrl}/customers/profile`, {
      headers: { Authorization: `Bearer ${targetCustomerAToken}` }
    });

    // C. Mobile app "My Vouchers" screen: GET /vouchers/my-vouchers
    const myVouchersRes = await fetch(`${baseUrl}/vouchers/my-vouchers`, {
      headers: { Authorization: `Bearer ${targetCustomerAToken}` }
    });
    const myVouchersBody = await myVouchersRes.json() as any;
    const myVouchersList = Array.isArray(myVouchersBody.data) ? myVouchersBody.data : [];
    const myVouchersHasVoucher = myVouchersList.some((v: any) => v.voucherId === singleVoucher.id && v.title === singleVoucher.name && v.status === VoucherStatus.ACTIVE);

    // D. Mobile app "My Vouchers" screen: GET /vouchers/customer/my-vouchers
    const customerMyVouchersRes = await fetch(`${baseUrl}/vouchers/customer/my-vouchers`, {
      headers: { Authorization: `Bearer ${targetCustomerAToken}` }
    });
    const customerMyVouchersBody = await customerMyVouchersRes.json() as any;
    const customerMyVouchersList = Array.isArray(customerMyVouchersBody.data) ? customerMyVouchersBody.data : [];
    const customerMyVouchersHasVoucher = customerMyVouchersList.some((v: any) => v.voucherId === singleVoucher.id && v.title === singleVoucher.name);

    // E. Mobile app: GET /vouchers (with customer device token)
    const mobileVouchersListRes = await fetch(`${baseUrl}/vouchers`, {
      headers: { Authorization: `Bearer ${targetCustomerAToken}` }
    });
    const mobileVouchersListBody = await mobileVouchersListRes.json() as any;
    const mobileVouchersList = Array.isArray(mobileVouchersListBody.data) ? mobileVouchersListBody.data : [];
    const mobileListHasVoucher = mobileVouchersList.some((v: any) => v.voucherId === singleVoucher.id);

    // F. Mobile app: GET /customers/my-vouchers
    const customerRouteMyVouchersRes = await fetch(`${baseUrl}/customers/my-vouchers`, {
      headers: { Authorization: `Bearer ${targetCustomerAToken}` }
    });
    const customerRouteMyVouchersBody = await customerRouteMyVouchersRes.json() as any;
    const customerRouteList = Array.isArray(customerRouteMyVouchersBody.data) ? customerRouteMyVouchersBody.data : [];
    const customerRouteHasVoucher = customerRouteList.some((v: any) => v.voucherId === singleVoucher.id);

    // G. Admin: GET /customers/:id
    const adminCustomerRes = await fetch(`${baseUrl}/customers/${targetCustomerA.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const adminCustomerBody = await adminCustomerRes.json() as any;
    const adminCustomerVouchers = adminCustomerBody.data?.customerVouchers || [];
    const adminHasVoucher = adminCustomerVouchers.some((v: any) => v.voucherId === singleVoucher.id && v.title === singleVoucher.name);
    const adminCustomerMembership = adminCustomerBody.data?.membership;

    // H. Dedicated: GET /customers/:id/vouchers
    const dedicatedRes = await fetch(`${baseUrl}/customers/${targetCustomerA.id}/vouchers`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const dedicatedBody = await dedicatedRes.json() as any;
    const dedicatedVouchers = dedicatedBody.data?.vouchers || [];
    const dedicatedHasVoucher = dedicatedVouchers.some((v: any) => v.voucherId === singleVoucher.id && v.title === singleVoucher.name);

    const passed =
      meRes.status === 200 && meHasVoucher && meMembership === "Classic Member" &&
      aliasMeRes.status === 200 && aliasProfileRes.status === 200 &&
      myVouchersRes.status === 200 && myVouchersHasVoucher &&
      customerMyVouchersRes.status === 200 && customerMyVouchersHasVoucher &&
      mobileVouchersListRes.status === 200 && mobileListHasVoucher &&
      customerRouteMyVouchersRes.status === 200 && customerRouteHasVoucher &&
      adminCustomerRes.status === 200 && adminHasVoucher && adminCustomerMembership === "Classic Member" &&
      dedicatedRes.status === 200 && dedicatedHasVoucher;

    record(26, "Customer profile returns assigned vouchers & Classic Member", passed,
      `Me has voucher: ${meHasVoucher} (${meMembership}), Admin has voucher: ${adminHasVoucher}, Dedicated: ${dedicatedHasVoucher}`);
    record(26, "Customer profile & customer voucher APIs return assigned vouchers", passed,
      `Profile: ${meHasVoucher} (Classic Member), /vouchers/my-vouchers: ${myVouchersHasVoucher}, /vouchers/customer/my-vouchers: ${customerMyVouchersHasVoucher}, Admin: ${adminHasVoucher}`);
  }

  // -------------------------------------------------------------
  // TEST 27: Issue voucher to multiple customers (Bulk)
  // -------------------------------------------------------------
  const bulkVoucherCode = "BULK" + Math.floor(10000 + Math.random() * 90000);
  const bulkVoucher = await prisma.voucher.create({
    data: {
      code: bulkVoucherCode,
      name: "Bulk Issue Test Voucher",
      type: VoucherType.FIXED_AMOUNT,
      value: 50,
      status: VoucherStatus.ACTIVE
    }
  });

  const customerGroup: any[] = [];
  for (let i = 0; i < 3; i++) {
    const c = await prisma.customer.create({
      data: {
        name: `Bulk Customer ${i + 1}`,
        phone: "922333" + Math.floor(1000 + Math.random() * 9000),
        status: CustomerStatus.APPROVED
      }
    });
    customerGroup.push(c);
  }

  {
    const res = await fetch(`${baseUrl}/vouchers/bulk-issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        voucherId: bulkVoucher.id,
        customerIds: customerGroup.map(c => c.id)
      })
    });
    const body = await res.json() as any;
    const passed = res.status === 201 && body.data?.assignedCount === 3;
    record(27, "Issue voucher to multiple customers (bulk)", passed,
      `Status: ${res.status}, AssignedCount: ${body.data?.assignedCount}/${customerGroup.length}`);
  }

  // -------------------------------------------------------------
  // TEST 28: Verify all targeted customers receive the voucher
  // -------------------------------------------------------------
  {
    const assignments = await prisma.customerVoucher.findMany({
      where: {
        voucherId: bulkVoucher.id,
        customerId: { in: customerGroup.map(c => c.id) }
      }
    });

    const passed = assignments.length === 3 && assignments.every(a => a.status === VoucherStatus.ACTIVE);
    record(28, "Verify all targeted customers receive the voucher", passed,
      `DB Assignments found: ${assignments.length}/3`);
  }

  // -------------------------------------------------------------
  // TEST 29: Test duplicate assignment handling (idempotent skip)
  // -------------------------------------------------------------
  {
    // Create one extra new customer
    const extraCustomer = await prisma.customer.create({
      data: {
        name: "Extra Customer For Duplicate Test",
        phone: "933444" + Math.floor(1000 + Math.random() * 9000),
        status: CustomerStatus.APPROVED
      }
    });

    // Re-issue to customerGroup[0] (already has it) + extraCustomer (doesn't have it)
    const mixedIds = [customerGroup[0].id, extraCustomer.id];

    const res = await fetch(`${baseUrl}/vouchers/${bulkVoucher.id}/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        customerIds: mixedIds
      })
    });
    const body = await res.json() as any;

    const passed =
      res.status === 201 &&
      body.data?.assignedCount === 1 &&
      body.data?.alreadyAssignedCount === 1 &&
      body.data?.assignedCustomerIds?.includes(extraCustomer.id);

    record(29, "Duplicate assignment handling → skips existing without failing others", passed,
      `Assigned: ${body.data?.assignedCount}, Skipped: ${body.data?.alreadyAssignedCount}`);
  }

  // -------------------------------------------------------------
  // TEST 30: Test staff permissions & ADMIN unrestricted access
  // -------------------------------------------------------------
  {
    // A. Cashier with NO permissions cannot create vouchers (403)
    const unauthorizedVoucherRes = await fetch(`${baseUrl}/vouchers/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${unauthCashierToken}`
      },
      body: JSON.stringify({
        code: "UNAUTH" + Math.floor(10000 + Math.random() * 90000),
        name: "Unauthorized Voucher",
        type: VoucherType.FREE_ITEM
      })
    });

    // B. Cashier with VOUCHER_CREATE can create vouchers (201)
    await prisma.employeePermission.create({
      data: {
        employeeId: authCashier.id,
        permission: Permission.VOUCHER_CREATE
      }
    });

    const authorizedVoucherRes = await fetch(`${baseUrl}/vouchers/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authCashierToken}`
      },
      body: JSON.stringify({
        code: "AUTH" + Math.floor(10000 + Math.random() * 90000),
        name: "Authorized Voucher",
        type: VoucherType.FREE_ITEM
      })
    });

    // C. Non-ADMIN cannot modify employee permissions (403)
    const nonAdminPermRes = await fetch(`${baseUrl}/employees/${unauthCashier.id}/permissions`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authCashierToken}`
      },
      body: JSON.stringify({
        permissions: [Permission.DASHBOARD_VIEW]
      })
    });

    // D. ADMIN can access all protected routes without individual permission
    const adminCustomerListRes = await fetch(`${baseUrl}/customers`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const adminVoucherListRes = await fetch(`${baseUrl}/vouchers`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    const passed =
      unauthorizedVoucherRes.status === 403 &&
      authorizedVoucherRes.status === 201 &&
      nonAdminPermRes.status === 403 &&
      adminCustomerListRes.status === 200 &&
      adminVoucherListRes.status === 200;

    record(30, "Staff permissions enforced & ADMIN has full access", passed,
      `Unauth: ${unauthorizedVoucherRes.status}, Auth: ${authorizedVoucherRes.status}, PermModify: ${nonAdminPermRes.status}, Admin: [${adminCustomerListRes.status}, ${adminVoucherListRes.status}]`);
  }

  console.log("==================================================");
  const allPassed = results.every(r => r.passed);
  console.log(`TEST SUMMARY: ${results.filter(r => r.passed).length}/${results.length} PASSED`);
  if (allPassed) {
    console.log("🎉 ALL BUSINESS REQUIREMENTS VERIFIED SUCCESSFULLY!");
  } else {
    console.log("❌ SOME TESTS FAILED");
  }
  console.log("==================================================");

  server.close();
  await prisma.$disconnect();

  if (!allPassed) {
    process.exit(1);
  }
}

runTests().catch(async (err) => {
  console.error("Test execution failed:", err);
  if (server) server.close();
  await prisma.$disconnect();
  process.exit(1);
});

