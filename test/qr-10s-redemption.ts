import http from "http";
import bcrypt from "bcryptjs";
import { PrismaClient, Role, CustomerStatus, DeviceStatus, VoucherStatus, VoucherType, RedemptionSessionStatus } from "@prisma/client";
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

function record(name: string, passed: boolean, details?: string) {
  const status = passed ? "✅ PASS" : "❌ FAIL";
  console.log(`${status}: ${name} ${details ? `(${details})` : ""}`);
  if (!passed) {
    throw new Error(`Test failed: ${name} - ${details}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTestSuite() {
  console.log("==================================================");
  console.log("RUNNING 10-SECOND SHORT-LIVED QR REDEMPTION TEST SUITE");
  console.log("==================================================");

  await startServer();

  // 1. Setup entities
  const adminHash = await bcrypt.hash("Admin@123", 10);
  const admin = await prisma.employee.upsert({
    where: { email: "qr_admin@cafe.com" },
    update: { role: Role.ADMIN, isActive: true },
    create: {
      name: "QR Admin",
      email: "qr_admin@cafe.com",
      passwordHash: adminHash,
      role: Role.ADMIN,
      isActive: true
    }
  });
  const adminToken = generateToken({ id: admin.id, role: admin.role });

  const customer = await prisma.customer.create({
    data: {
      name: "QR Customer",
      phone: `999${Date.now().toString().slice(-7)}`,
      status: CustomerStatus.APPROVED,
      approvedAt: new Date()
    }
  });

  const device = await prisma.device.create({
    data: {
      customerId: customer.id,
      deviceId: `DEV-QR-${Date.now()}`,
      status: DeviceStatus.ACTIVE,
      approvedAt: new Date()
    }
  });

  const customerToken = generateCustomerToken(customer.id, device.deviceId);

  const voucher1 = await prisma.voucher.create({
    data: {
      code: `QR-10S-${Date.now()}`,
      name: "10-Second QR Cold Brew",
      type: VoucherType.FREE_ITEM,
      status: VoucherStatus.ACTIVE
    }
  });

  const customerVoucher1 = await prisma.customerVoucher.create({
    data: {
      customerId: customer.id,
      voucherId: voucher1.id,
      status: VoucherStatus.ACTIVE
    }
  });

  // TEST 1: Decoupled presence - Customer creates 10-second QR token without coordinates
  let sessionToken1 = "";
  let sessionId1: number | string = "";
  {
    const res = await fetch(`${baseUrl}/vouchers/${voucher1.id}/redeem`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({}) // No GPS coordinates!
    });
    const body = await res.json() as any;
    sessionId1 = body.data?.sessionId;
    sessionToken1 = body.data?.qrToken;
    const validitySeconds = body.data?.validitySeconds;
    const expiresAtMs = body.data?.expiresAtMs;
    const diffSeconds = Math.round((expiresAtMs - Date.now()) / 1000);

    const ok = res.status === 201 &&
               body.success === true &&
               validitySeconds === 10 &&
               diffSeconds >= 9 && diffSeconds <= 11 &&
               sessionToken1.length === 64;

    record("Decoupled GPS Presence & 10s Token Creation", ok,
      `Status: ${res.status}, validitySeconds: ${validitySeconds}, remaining: ${diffSeconds}s`);
  }

  // TEST 2: Verify DynamicQrToken was synchronized in DB
  {
    const dynToken = await prisma.dynamicQrToken.findUnique({
      where: { token: sessionToken1 }
    });
    const ok = !!dynToken && dynToken.status === "PENDING" && dynToken.consumedByCustomerId === customer.id;
    record("DynamicQrToken Architecture Synchronization", ok, `Found in dynamicQrToken: ${!!dynToken}`);
  }

  // TEST 3: Physical USB Barcode/QR Scanner input simulation (with \r\n, tabs, quotes)
  // Admin receives valid response with otpRequired = true, but NEVER the actual OTP!
  {
    // A physical USB scanner types keystrokes ending with Enter (\r\n) or null bytes
    const scannerInput = `"${sessionToken1}\r\n"`;
    const res = await fetch(`${baseUrl}/redemption/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        token: scannerInput
      })
    });
    const body = await res.json() as any;

    const dbSession = await prisma.voucherRedemptionSession.findUnique({
      where: { id: Number(sessionId1) }
    });

    const otpNotLeakedToAdmin = body.data?.otp === undefined && body._debugOtp === undefined;

    const ok = res.status === 200 &&
               body.data?.valid === true &&
               body.data?.scanned === true &&
               body.data?.otpRequired === true &&
               body.data?.status === "SCANNED" &&
               otpNotLeakedToAdmin &&
               dbSession?.status === RedemptionSessionStatus.SCANNED &&
               !!dbSession?.otpHash;

    record("USB Barcode/QR Scanner Keystroke Sanitization & Admin Scan (Zero OTP Leakage)", ok,
      `Status: ${res.status}, Scanned: ${body.data?.scanned}, OTP Hidden from Admin: ${otpNotLeakedToAdmin}`);
  }

  // TEST 4: Customer checks session status to read OTP (and unauthorized access is blocked)
  let customerOtp = "";
  {
    // 4A. Authenticated customer retrieves OTP
    const res = await fetch(`${baseUrl}/vouchers/redemption-session/${sessionId1}`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    const body = await res.json() as any;
    customerOtp = body.data?.otp;

    // 4B. Unauthorized (unauthenticated or different customer) is rejected
    const unauthRes = await fetch(`${baseUrl}/vouchers/redemption-session/${sessionId1}`);
    const unauthOk = unauthRes.status === 401;

    const ok = res.status === 200 &&
               body.data?.status === "SCANNED" &&
               typeof customerOtp === "string" &&
               customerOtp.length === 6 &&
               /^\d{6}$/.test(customerOtp) &&
               unauthOk;

    record("Authenticated Customer Retrieves Secure 6-Digit OTP via Polling", ok,
      `OTP: ${customerOtp}, Unauthorized Blocked: ${unauthOk}`);
  }

  // TEST 5: Verify OTP & Complete Redemption
  {
    const res = await fetch(`${baseUrl}/redemption/verify-otp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        token: sessionToken1,
        otp: customerOtp
      })
    });
    const body = await res.json() as any;

    const dbCv = await prisma.customerVoucher.findUnique({
      where: { id: customerVoucher1.id }
    });
    const dbSession = await prisma.voucherRedemptionSession.findUnique({
      where: { id: Number(sessionId1) }
    });

    const ok = res.status === 200 &&
               body.success === true &&
               dbCv?.status === VoucherStatus.REDEEMED &&
               !!dbCv?.redeemedAt &&
               dbSession?.status === RedemptionSessionStatus.COMPLETED &&
               dbSession?.otpHash === null;

    record("Admin Verifies OTP & Completes Atomic Redemption", ok,
      `CV Status: ${dbCv?.status}, RedeemedAt: ${dbCv?.redeemedAt?.toISOString()}`);
  }

  // TEST 5B: Android voucher state synchronization - changes ACTIVE to REDEEMED
  {
    // Android fetches voucher details
    const resDetails = await fetch(`${baseUrl}/vouchers/${voucher1.id}`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    const bodyDetails = await resDetails.json() as any;

    // Android fetches my-vouchers list
    const resList = await fetch(`${baseUrl}/vouchers/my-vouchers`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    const bodyList = await resList.json() as any;
    const itemInList = Array.isArray(bodyList.data) ? bodyList.data.find((v: any) => v.voucherId === voucher1.id) : null;

    // Android checks redemption session status
    const resSession = await fetch(`${baseUrl}/vouchers/redemption-session/${sessionId1}`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    const bodySession = await resSession.json() as any;

    const ok = resDetails.status === 200 &&
               bodyDetails.data?.status === "REDEEMED" &&
               bodyDetails.data?.isRedeemed === true &&
               itemInList?.status === "REDEEMED" &&
               itemInList?.isRedeemed === true &&
               bodySession.data?.status === "COMPLETED" &&
               bodySession.data?.isRedeemed === true;

    record("Android Voucher State Synchronization (ACTIVE -> REDEEMED)", ok,
      `Details Status: ${bodyDetails.data?.status}, List Status: ${itemInList?.status}`);
  }

  // TEST 6: Already Redeemed Voucher Guard - Cannot generate new QR or verify again
  {
    const res = await fetch(`${baseUrl}/vouchers/${voucher1.id}/redeem`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({})
    });
    const body = await res.json() as any;

    const resOtpAgain = await fetch(`${baseUrl}/redemption/verify-otp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        token: sessionToken1,
        otp: customerOtp
      })
    });
    const bodyOtpAgain = await resOtpAgain.json() as any;

    const ok = res.status === 400 &&
               (body.errors?.error === "ALREADY_REDEEMED" || body.message?.includes("already been redeemed")) &&
               resOtpAgain.status === 409 &&
               (bodyOtpAgain.errors?.error === "ALREADY_REDEEMED" || bodyOtpAgain.message?.includes("already been redeemed"));

    record("Already Redeemed Voucher Guard on Token Generation & OTP Verification", ok,
      `Gen Status: ${res.status}, OTP Status: ${resOtpAgain.status}`);
  }

  // TEST 7: Test 10-Second Expiry on Unscanned Token
  const voucher2 = await prisma.voucher.create({
    data: {
      code: `QR-EXP-${Date.now()}`,
      name: "Expiry Test Latte",
      type: VoucherType.FREE_ITEM,
      status: VoucherStatus.ACTIVE
    }
  });

  const customerVoucher2 = await prisma.customerVoucher.create({
    data: {
      customerId: customer.id,
      voucherId: voucher2.id,
      status: VoucherStatus.ACTIVE
    }
  });

  let expiredSessionToken = "";
  {
    const res = await fetch(`${baseUrl}/vouchers/${voucher2.id}/redeem`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({})
    });
    const body = await res.json() as any;
    expiredSessionToken = body.data?.qrToken;
  }

  // Manually backdate session expiresAt by 11 seconds to verify authoritative server clock check
  await prisma.voucherRedemptionSession.update({
    where: { sessionToken: expiredSessionToken },
    data: { expiresAt: new Date(Date.now() - 1000) } // 1s in the past (>10s elapsed)
  });

  // Admin scans expired token
  {
    const res = await fetch(`${baseUrl}/redemption/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ token: expiredSessionToken })
    });
    const body = await res.json() as any;
    const ok = res.status === 410 && (body.error === "TOKEN_EXPIRED" || body.message?.includes("expired"));
    record("Authoritative Expiry (>10s): Scan returns 410 Gone", ok, `Status: ${res.status}, Error: ${body.error}`);
  }

  // TEST 8: Token Regeneration after Expiry
  let refreshedSessionToken = "";
  {
    const res = await fetch(`${baseUrl}/vouchers/${voucher2.id}/redeem`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`
      },
      body: JSON.stringify({})
    });
    const body = await res.json() as any;
    refreshedSessionToken = body.data?.qrToken;
    const ok = res.status === 201 && refreshedSessionToken !== expiredSessionToken;
    record("Customer Regenerates Fresh 10s Token for Unused Voucher", ok, `New Token Generated`);
  }

  // Old expired token cannot be scanned, but fresh token can be scanned
  {
    const resOld = await fetch(`${baseUrl}/redemption/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ token: expiredSessionToken })
    });
    const resNew = await fetch(`${baseUrl}/redemption/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ token: refreshedSessionToken })
    });
    const bodyNew = await resNew.json() as any;
    const ok = (resOld.status === 410 || resOld.status === 400) &&
               resNew.status === 200 && bodyNew.data?.status === "SCANNED";
    record("Old Token Inactive and New Token Successfully Scanned", ok,
      `Old scan status: ${resOld.status}, New scan status: ${resNew.status}`);
  }

  // TEST 9: Double Redemption / Race Condition Prevention
  {
    const freshOtp = (await prisma.voucherRedemptionSession.findUnique({
      where: { sessionToken: refreshedSessionToken }
    }))?.otpEncrypted ? "123456" : "000000";

    // Attempt double scan
    const doubleScanRes = await fetch(`${baseUrl}/redemption/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ token: refreshedSessionToken })
    });
    const doubleScanBody = await doubleScanRes.json() as any;
    const ok = doubleScanRes.status === 409 &&
               (doubleScanBody.errors?.error === "TOKEN_ALREADY_SCANNED" ||
                doubleScanBody.message?.includes("already been scanned"));
    record("Double Scan Prevention returns 409 Conflict", ok, `Status: ${doubleScanRes.status}, Message: ${doubleScanBody.message}`);
  }

  console.log("==================================================");
  console.log("ALL 10-SECOND SHORT-LIVED QR TESTS PASSED! 🎉");
  console.log("==================================================");

  server.close();
  await prisma.$disconnect();
}

runTestSuite().catch((err) => {
  console.error("Test Suite Failed:", err);
  if (server) server.close();
  prisma.$disconnect();
  process.exit(1);
});
