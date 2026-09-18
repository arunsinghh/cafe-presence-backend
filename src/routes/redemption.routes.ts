import { Router, NextFunction, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import {
  CustomerStatus,
  DeviceStatus,
  Permission,
  PresenceMethod,
  PresenceResult,
  QrStatus,
  RedemptionSessionStatus,
  VoucherStatus
} from "@prisma/client";

import { prisma } from "../config/prisma";
import {
  AuthenticatedRequest,
  authenticateEmployee,
  authenticateCustomerDevice
} from "../middleware/auth";
import { authorizePermission } from "../middleware/permission";
import { calculateHaversineDistance } from "../utils/geo";
import { logAudit } from "../utils/audit";
import { errorResponse, successResponse } from "../utils/response";

const router = Router();

/* =========================================================
   OTP ENCRYPTION HELPERS (No plaintext OTP in DB)
   ========================================================= */

const ALGORITHM = "aes-256-cbc";

const getCipherKey = (): Buffer => {
  const secret =
    process.env.JWT_CUSTOMER_SECRET ||
    "fallback-secret-cafe-presence-2026-key";
  return crypto.createHash("sha256").update(secret).digest();
};

export const encryptOtp = (otp: string): string => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getCipherKey(), iv);
  let encrypted = cipher.update(otp, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`;
};

export const decryptOtp = (encryptedPayload: string): string => {
  try {
    const [ivHex, dataHex] = encryptedPayload.split(":");
    if (!ivHex || !dataHex) return "";
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, getCipherKey(), iv);
    let decrypted = decipher.update(dataHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return "";
  }
};

/* =========================================================
   TOKEN EXTRACTION & VALIDATION SCHEMAS
   ========================================================= */

/**
 * Helper to reliably extract the clean token string from various QR representations:
 * - Direct token string: "4a2b..."
 * - Keystroke string from USB barcode/QR scanner: contains trailing \r\n, control characters, null bytes
 * - JSON string: '{"token":"4a2b...", ...}' or '{"qrToken":"4a2b..."}'
 * - Object: { token, qrToken, qrData, code, voucherCode }
 * - URL or prefix: "https://.../redeem?token=4a2b..." or "REDEEM:4a2b..."
 */
export const extractQrToken = (rawInput: unknown): string => {
  if (!rawInput) return "";

  if (typeof rawInput === "object") {
    const obj = rawInput as Record<string, any>;
    const candidate =
      obj.token ?? obj.qrToken ?? obj.qrData ?? obj.code ?? obj.voucherCode ?? obj.sessionId;
    if (candidate !== undefined) return extractQrToken(candidate);
  }

  if (typeof rawInput !== "string") return String(rawInput).trim();

  let str = rawInput.trim();

  // Strip non-printable / control characters (such as \r, \n, \t, null bytes \0)
  // commonly emitted by USB barcode / QR keyboard-emulating scanners
  str = str.replace(/[\x00-\x1F\x7F]/g, "").trim();

  // Strip wrapping quotes
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }

  // Check if string is a JSON object
  if (str.startsWith("{") && str.endsWith("}")) {
    try {
      const parsed = JSON.parse(str);
      const extracted =
        parsed.token || parsed.qrToken || parsed.qrData || parsed.code || parsed.sessionId;
      if (extracted) return extractQrToken(extracted);
    } catch {
      // ignore JSON parse error, treat as raw string
    }
  }

  // Check if string is a URL containing token or code query param
  if (str.includes("?")) {
    try {
      const url = new URL(str.startsWith("http") ? str : `http://localhost/${str}`);
      const param =
        url.searchParams.get("token") ||
        url.searchParams.get("qrToken") ||
        url.searchParams.get("qrData") ||
        url.searchParams.get("code");
      if (param) return extractQrToken(param);
    } catch {
      // ignore URL parse error
    }
  }

  // Strip AIM symbology prefix (e.g. "]Q1", "]Q2", "]Q3", "]C1")
  if (str.startsWith("]") && str.length > 3) {
    str = str.slice(3).trim();
  }

  // If token is a 64-char hex string, normalize to lowercase
  if (/^[0-9a-fA-F]{64}$/.test(str)) {
    str = str.toLowerCase();
  }

  return str.replace(/[\x00-\x1F\x7F]/g, "").trim();
};

const createSessionSchema = z.object({
  voucherId: z.coerce.number().int().positive().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracy: z.number().nonnegative().optional()
});

const scanQrSchema = z
  .object({
    token: z.unknown().optional(),
    qrToken: z.unknown().optional(),
    qrData: z.unknown().optional(),
    code: z.unknown().optional(),
    voucherCode: z.unknown().optional()
  })
  .passthrough()
  .transform((data) => {
    const raw =
      data.token ?? data.qrToken ?? data.qrData ?? data.code ?? data.voucherCode;
    const token = extractQrToken(raw);
    return { token };
  })
  .refine((data) => data.token.length > 0, {
    message: "A non-empty QR token is required"
  });

const verifyOtpSchema = z
  .object({
    token: z.unknown().optional(),
    qrToken: z.unknown().optional(),
    qrData: z.unknown().optional(),
    sessionId: z.unknown().optional(),
    customerVoucherId: z.coerce.number().int().positive().optional(),
    otp: z.coerce.string().trim().min(4).max(10)
  })
  .passthrough()
  .transform((data) => {
    const raw = data.token ?? data.qrToken ?? data.qrData ?? data.sessionId;
    const token = raw !== undefined ? extractQrToken(raw) : "";
    return {
      token,
      customerVoucherId: data.customerVoucherId,
      otp: data.otp
    };
  })
  .refine((data) => data.token.length > 0 || data.customerVoucherId !== undefined, {
    message: "Must provide redemption token or customerVoucherId"
  });

/* =========================================================
   STEP 3 & 4: CUSTOMER CREATES REDEMPTION SESSION
   POST /session (or POST /:voucherId/redemption-session)
   ========================================================= */

export const handleCreateRedemptionSession = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.device) {
      errorResponse(res, "Customer device authentication required", 401);
      return;
    }

    const customerId = req.device.customerId;
    const deviceId = req.device.id;

    // Voucher identifier from params (if called via /:id/redemption-session) or body
    const paramId = req.params.voucherId || req.params.id;
    const rawVoucherId = paramId ? Number(paramId) : req.body.voucherId;

    if (!rawVoucherId || isNaN(rawVoucherId) || rawVoucherId <= 0) {
      errorResponse(res, "A valid voucher ID is required", 400);
      return;
    }

    const data = createSessionSchema.parse(req.body);

    const now = new Date();

    // 1. Validate Voucher & CustomerVoucher ownership
    const customerVoucher = await prisma.customerVoucher.findFirst({
      where: {
        customerId,
        OR: [{ voucherId: rawVoucherId }, { id: rawVoucherId }]
      },
      include: {
        voucher: true
      }
    });

    if (!customerVoucher) {
      errorResponse(
        res,
        "Voucher has not been issued to this customer",
        404
      );
      return;
    }

    if (customerVoucher.status !== VoucherStatus.ACTIVE) {
      errorResponse(
        res,
        customerVoucher.status === VoucherStatus.REDEEMED
          ? "Voucher has already been redeemed"
          : "Customer voucher is not active",
        400,
        {
          error:
            customerVoucher.status === VoucherStatus.REDEEMED
              ? "ALREADY_REDEEMED"
              : "VOUCHER_NOT_ACTIVE",
          status: customerVoucher.status
        }
      );
      return;
    }

    if (customerVoucher.expiresAt && customerVoucher.expiresAt <= now) {
      errorResponse(res, "Customer voucher has expired", 400);
      return;
    }

    const voucher = customerVoucher.voucher;

    if (voucher.status !== VoucherStatus.ACTIVE) {
      errorResponse(res, "Voucher is not active", 400);
      return;
    }

    if (voucher.startsAt && voucher.startsAt > now) {
      errorResponse(res, "Voucher is not active yet", 400);
      return;
    }

    if (voucher.expiresAt && voucher.expiresAt <= now) {
      errorResponse(res, "Voucher has expired", 400);
      return;
    }

    if (
      voucher.maxRedemptions !== null &&
      voucher.redeemedCount >= voucher.maxRedemptions
    ) {
      errorResponse(
        res,
        "Voucher redemption limit has been reached",
        400
      );
      return;
    }

    // 2. Presence verification is strictly decoupled from voucher QR generation.
    // Telemetry log if GPS coordinates are provided (non-blocking)
    if (data.latitude !== undefined && data.longitude !== undefined) {
      try {
        const cafeConfig = await prisma.cafeConfig.findUnique({
          where: { id: 1 }
        });
        if (cafeConfig) {
          const distanceMeters = calculateHaversineDistance(
            data.latitude,
            data.longitude,
            cafeConfig.latitude,
            cafeConfig.longitude
          );
          await prisma.presenceLog.create({
            data: {
              customerId,
              deviceId,
              method: PresenceMethod.GPS,
              latitude: data.latitude,
              longitude: data.longitude,
              accuracy: data.accuracy ?? null,
              distanceMeters,
              purpose: "VOUCHER_REDEMPTION",
              result: distanceMeters <= cafeConfig.allowedRadiusMeters ? PresenceResult.SUCCESS : PresenceResult.REJECTED,
              timestamp: now
            }
          });
        }
      } catch {
        // Non-blocking telemetry
      }
    }

    // 3. Cancel any previous lingering sessions for this customer voucher
    await prisma.voucherRedemptionSession.updateMany({
      where: {
        customerVoucherId: customerVoucher.id,
        status: {
          in: [RedemptionSessionStatus.CREATED, RedemptionSessionStatus.SCANNED]
        }
      },
      data: {
        status: RedemptionSessionStatus.CANCELLED
      }
    });

    // 4. Create short-lived, one-time redemption session (EXACTLY 10 SECONDS)
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const sessionExpiresAt = new Date(now.getTime() + 10 * 1000); // 10 seconds validity

    const session = await prisma.voucherRedemptionSession.create({
      data: {
        sessionToken,
        customerId,
        customerVoucherId: customerVoucher.id,
        voucherId: voucher.id,
        status: RedemptionSessionStatus.CREATED,
        expiresAt: sessionExpiresAt
      }
    });

    // Synchronize with DynamicQrToken architecture for comprehensive audit
    try {
      await prisma.dynamicQrToken.create({
        data: {
          token: sessionToken,
          status: QrStatus.PENDING,
          expiresAt: sessionExpiresAt,
          consumedByCustomerId: customerId,
          consumedByDeviceId: deviceId
        }
      });
    } catch {
      // DynamicQrToken tracking non-blocking
    }

    successResponse(
      res,
      {
        sessionId: session.id,
        id: session.id,
        sessionToken: session.sessionToken,
        qrToken: session.sessionToken,
        token: session.sessionToken,
        expiresAt: session.expiresAt.toISOString(),
        expiresAtMs: session.expiresAt.getTime(),
        validitySeconds: 10,
        status: session.status,
        voucher: {
          id: voucher.id,
          name: voucher.name,
          title: voucher.name,
          code: voucher.code,
          type: voucher.type,
          value: voucher.value
        },
        customerVoucher
      },
      "Redemption session created successfully",
      201
    );
  } catch (error) {
    next(error);
  }
};

router.post("/session", authenticateCustomerDevice, handleCreateRedemptionSession);

/* =========================================================
   CUSTOMER CHECKS SESSION STATUS & RETRIEVES OTP
   GET /session/:token or GET /session/:sessionId
   ========================================================= */

export const handleGetRedemptionSessionStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.device && !req.user) {
      errorResponse(res, "Authentication required", 401);
      return;
    }

    const tokenOrId =
      req.params.sessionId ||
      req.params.token ||
      req.params.voucherId ||
      req.params.id;
    if (!tokenOrId) {
      errorResponse(res, "Session identifier is required", 400);
      return;
    }

    const now = new Date();

    let session = await prisma.voucherRedemptionSession.findUnique({
      where: { sessionToken: tokenOrId },
      include: {
        voucher: true,
        customer: true,
        customerVoucher: true
      }
    });

    if (!session && /^\d+$/.test(tokenOrId)) {
      session = await prisma.voucherRedemptionSession.findUnique({
        where: { id: parseInt(tokenOrId, 10) },
        include: {
          voucher: true,
          customer: true,
          customerVoucher: true
        }
      });
    }

    // Fallback: If tokenOrId is a voucherId or customerVoucherId, find the customer's latest session
    if (!session && /^\d+$/.test(tokenOrId) && req.device) {
      const numId = parseInt(tokenOrId, 10);
      session = await prisma.voucherRedemptionSession.findFirst({
        where: {
          customerId: req.device.customerId,
          OR: [{ voucherId: numId }, { customerVoucherId: numId }]
        },
        orderBy: { createdAt: "desc" },
        include: {
          voucher: true,
          customer: true,
          customerVoucher: true
        }
      });
    }

    if (!session) {
      errorResponse(res, "Redemption session not found", 404);
      return;
    }

    if (req.device && session.customerId !== req.device.customerId) {
      errorResponse(res, "Unauthorized access to redemption session", 403);
      return;
    }

    // Check 10-second QR token expiry for CREATED sessions
    if (
      session.status === RedemptionSessionStatus.CREATED &&
      session.expiresAt <= now
    ) {
      await prisma.voucherRedemptionSession.update({
        where: { id: session.id },
        data: { status: RedemptionSessionStatus.EXPIRED }
      });

      errorResponse(res, "QR token expired. Please scan the new QR code.", 410, {
        status: RedemptionSessionStatus.EXPIRED,
        error: "TOKEN_EXPIRED",
        expired: true
      });
      return;
    }

    // Check OTP expiry for SCANNED sessions
    if (
      session.status === RedemptionSessionStatus.SCANNED &&
      session.otpExpiresAt &&
      session.otpExpiresAt <= now
    ) {
      await prisma.voucherRedemptionSession.update({
        where: { id: session.id },
        data: { status: RedemptionSessionStatus.EXPIRED }
      });

      errorResponse(res, "OTP has expired. Please generate a new QR token.", 410, {
        status: RedemptionSessionStatus.EXPIRED,
        error: "OTP_EXPIRED",
        expired: true
      });
      return;
    }

    let plainOtp: string | null = null;
    if (
      session.status === RedemptionSessionStatus.SCANNED &&
      session.otpEncrypted &&
      session.otpExpiresAt &&
      session.otpExpiresAt > now
    ) {
      plainOtp = decryptOtp(session.otpEncrypted);
    }

    successResponse(
      res,
      {
        sessionId: String(session.id),
        id: session.id,
        sessionToken: session.sessionToken,
        qrToken: session.sessionToken,
        status: session.status,
        expiresAt: session.expiresAt.toISOString(),
        expiresAtMs: session.expiresAt.getTime(),
        validitySeconds: 10,
        scannedAt: session.scannedAt,
        otp: plainOtp,
        otpExpiresAt: session.otpExpiresAt,
        redeemedAt: session.redeemedAt,
        voucher: {
          id: session.voucher.id,
          name: session.voucher.name,
          title: session.voucher.name,
          code: session.voucher.code,
          type: session.voucher.type,
          value: session.voucher.value
        },
        customerVoucher: session.customerVoucher
          ? {
              id: session.customerVoucher.id,
              customerId: session.customerVoucher.customerId,
              voucherId: session.customerVoucher.voucherId,
              status: session.customerVoucher.status,
              redeemedAt: session.customerVoucher.redeemedAt,
              issuedAt: session.customerVoucher.issuedAt,
              expiresAt: session.customerVoucher.expiresAt
            }
          : null,
        voucherStatus: session.customerVoucher?.status ?? session.voucher.status,
        isRedeemed:
          session.customerVoucher?.status === VoucherStatus.REDEEMED ||
          session.status === RedemptionSessionStatus.COMPLETED
      },
      "Redemption session status retrieved successfully"
    );
  } catch (error) {
    next(error);
  }
};

router.get("/session/:token", authenticateCustomerDevice, handleGetRedemptionSessionStatus);
router.get("/session/:sessionId", authenticateCustomerDevice, handleGetRedemptionSessionStatus);
router.get("/session/voucher/:voucherId", authenticateCustomerDevice, handleGetRedemptionSessionStatus);

/* =========================================================
   STEP 5 & 6: ADMIN CASHIER SCANS QR
   POST /scan
   Triggers OTP generation ONLY after successful QR scan.
   ========================================================= */

export const handleScanRedemptionQr = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      errorResponse(res, "Employee authentication required", 401);
      return;
    }

    const { token } = scanQrSchema.parse(req.body);
    const now = new Date();

    // 1. Direct sessionToken lookup
    let session = await prisma.voucherRedemptionSession.findUnique({
      where: { sessionToken: token },
      include: {
        customer: true,
        customerVoucher: {
          include: { voucher: true }
        },
        voucher: true
      }
    });

    // 2. Numeric session ID fallback
    if (!session && /^\d+$/.test(token)) {
      session = await prisma.voucherRedemptionSession.findUnique({
        where: { id: parseInt(token, 10) },
        include: {
          customer: true,
          customerVoucher: {
            include: { voucher: true }
          },
          voucher: true
        }
      });
    }

    // 3. Fallback: voucher code match on active CREATED session
    if (!session) {
      session = await prisma.voucherRedemptionSession.findFirst({
        where: {
          status: RedemptionSessionStatus.CREATED,
          expiresAt: { gt: now },
          OR: [
            { voucher: { code: token } },
            { customerVoucher: { voucher: { code: token } } }
          ]
        },
        orderBy: { createdAt: "desc" },
        include: {
          customer: true,
          customerVoucher: {
            include: { voucher: true }
          },
          voucher: true
        }
      });
    }

    // 4. Fallback: offline mock token pattern (e.g. REDEEM_<voucherId>_<timestamp> or SESSION_<voucherId>_<timestamp>)
    if (!session && (token.startsWith("REDEEM_") || token.startsWith("SESSION_"))) {
      const parts = token.split("_");
      const vId = parseInt(parts[1], 10);
      if (!isNaN(vId)) {
        session = await prisma.voucherRedemptionSession.findFirst({
          where: {
            customerVoucher: {
              OR: [{ id: vId }, { voucherId: vId }]
            },
            status: RedemptionSessionStatus.CREATED,
            expiresAt: { gt: now }
          },
          orderBy: { createdAt: "desc" },
          include: {
            customer: true,
            customerVoucher: {
              include: { voucher: true }
            },
            voucher: true
          }
        });
      }
    }

    if (!session) {
      errorResponse(res, "Invalid redemption token", 404, {
        error: "TOKEN_INVALID"
      });
      return;
    }

    if (session.status === RedemptionSessionStatus.COMPLETED || session.customerVoucher.status === VoucherStatus.REDEEMED) {
      errorResponse(res, "Voucher has already been redeemed", 409, {
        error: "VOUCHER_ALREADY_REDEEMED"
      });
      return;
    }

    if (session.status === RedemptionSessionStatus.CANCELLED) {
      errorResponse(res, "Redemption session has been cancelled", 400, {
        error: "SESSION_CANCELLED"
      });
      return;
    }

    // Strict 10-second expiration check
    if (session.status === RedemptionSessionStatus.EXPIRED || session.expiresAt <= now) {
      if (session.status !== RedemptionSessionStatus.EXPIRED) {
        await prisma.voucherRedemptionSession.update({
          where: { id: session.id },
          data: { status: RedemptionSessionStatus.EXPIRED }
        });
      }
      try {
        await prisma.dynamicQrToken.updateMany({
          where: { token: session.sessionToken, status: QrStatus.PENDING },
          data: { status: QrStatus.EXPIRED }
        });
      } catch {
        // Non-blocking
      }
      errorResponse(res, "QR token expired. Please scan the new QR code.", 410, {
        error: "TOKEN_EXPIRED",
        expired: true
      });
      return;
    }

    if (session.status === RedemptionSessionStatus.SCANNED) {
      errorResponse(res, "QR token has already been scanned", 409, {
        error: "TOKEN_ALREADY_SCANNED"
      });
      return;
    }

    if (session.status !== RedemptionSessionStatus.CREATED) {
      errorResponse(res, "Invalid redemption session status", 400);
      return;
    }

    // Validate Customer eligibility
    if (session.customer.status !== CustomerStatus.APPROVED) {
      errorResponse(res, "Customer account is not approved", 403);
      return;
    }

    // Validate CustomerVoucher
    if (session.customerVoucher.status !== VoucherStatus.ACTIVE) {
      errorResponse(res, "Customer voucher is not active", 400);
      return;
    }

    // Validate Voucher
    if (session.voucher.status !== VoucherStatus.ACTIVE) {
      errorResponse(res, "Voucher is not active", 400);
      return;
    }

    if (
      session.voucher.maxRedemptions !== null &&
      session.voucher.redeemedCount >= session.voucher.maxRedemptions
    ) {
      errorResponse(res, "Voucher maximum redemptions reached", 400);
      return;
    }

    // STEP 6: Generate short-lived OTP strictly AFTER scan validation
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
    const otpEncrypted = encryptOtp(otp);
    const otpExpiresAt = new Date(now.getTime() + 3 * 60 * 1000); // 3 minutes

    const updatedSession = await prisma.voucherRedemptionSession.update({
      where: { id: session.id },
      data: {
        status: RedemptionSessionStatus.SCANNED,
        scannedAt: now,
        scannedByEmployeeId: req.user.id,
        otpHash,
        otpEncrypted,
        otpExpiresAt,
        otpAttempts: 0
      }
    });

    try {
      await prisma.dynamicQrToken.updateMany({
        where: { token: session.sessionToken, status: QrStatus.PENDING },
        data: {
          status: QrStatus.CONSUMED,
          consumedAt: now
        }
      });
    } catch {
      // Non-blocking
    }

    await logAudit({
      employeeId: req.user.id,
      action: "REDEMPTION_QR_SCANNED",
      entityType: "VoucherRedemptionSession",
      entityId: String(session.id),
      details: {
        sessionId: session.id,
        voucherId: session.voucherId,
        customerVoucherId: session.customerVoucherId,
        customerId: session.customerId,
        voucherCode: session.voucher.code
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });

    const responsePayload = {
      valid: true,
      scanned: true,
      otpRequired: true,
      sessionId: updatedSession.id,
      sessionToken: updatedSession.sessionToken,
      qrToken: updatedSession.sessionToken,
      status: updatedSession.status,
      otpExpiresAt: updatedSession.otpExpiresAt,
      voucher: {
        id: session.voucher.id,
        name: session.voucher.name,
        title: session.voucher.name,
        code: session.voucher.code,
        type: session.voucher.type,
        value: session.voucher.value
      },
      customer: {
        id: session.customer.id,
        name: session.customer.name,
        phone: session.customer.phone,
        email: session.customer.email
      },
      customerVoucher: session.customerVoucher
    };

    successResponse(
      res,
      responsePayload,
      "QR scanned successfully. OTP generated. Waiting for customer OTP."
    );
  } catch (error) {
    next(error);
  }
};

router.post(
  "/scan",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_REDEEM),
  handleScanRedemptionQr
);

/* =========================================================
   STEP 7 & 8: ADMIN VERIFIES OTP & ATOMIC REDEMPTION
   POST /verify-otp
   ========================================================= */

export const handleVerifyOtpAndRedeem = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      errorResponse(res, "Employee authentication required", 401);
      return;
    }

    const { token, customerVoucherId, otp } = verifyOtpSchema.parse(req.body);
    const now = new Date();

    const employeeId = req.user.id;

    // 1. Direct sessionToken lookup
    let session = token
      ? await prisma.voucherRedemptionSession.findUnique({
          where: { sessionToken: token },
          include: {
            voucher: true,
            customer: true,
            customerVoucher: true
          }
        })
      : null;

    // 2. Numeric session ID fallback
    if (!session && token && /^\d+$/.test(token)) {
      session = await prisma.voucherRedemptionSession.findUnique({
        where: { id: parseInt(token, 10) },
        include: {
          voucher: true,
          customer: true,
          customerVoucher: true
        }
      });
    }

    // 3. Fallback: by customerVoucherId in SCANNED status
    if (!session && customerVoucherId) {
      session = await prisma.voucherRedemptionSession.findFirst({
        where: {
          customerVoucherId,
          status: RedemptionSessionStatus.SCANNED
        },
        orderBy: { createdAt: "desc" },
        include: {
          voucher: true,
          customer: true,
          customerVoucher: true
        }
      });
    }

    if (!session) {
      errorResponse(res, "Redemption session not found", 404);
      return;
    }

    if (
      session.status === RedemptionSessionStatus.COMPLETED ||
      session.customerVoucher.status === VoucherStatus.REDEEMED
    ) {
      errorResponse(res, "Voucher has already been redeemed", 409, {
        error: "ALREADY_REDEEMED"
      });
      return;
    }

    if (session.status !== RedemptionSessionStatus.SCANNED) {
      errorResponse(res, "Redemption session is not in SCANNED status", 400);
      return;
    }

    if (!session.otpExpiresAt || session.otpExpiresAt <= now) {
      await prisma.voucherRedemptionSession.update({
        where: { id: session.id },
        data: { status: RedemptionSessionStatus.EXPIRED }
      });
      errorResponse(
        res,
        "OTP has expired. Please request a new redemption session.",
        400
      );
      return;
    }

    if (session.otpAttempts >= session.maxOtpAttempts) {
      await prisma.voucherRedemptionSession.update({
        where: { id: session.id },
        data: { status: RedemptionSessionStatus.EXPIRED }
      });
      errorResponse(
        res,
        "Maximum OTP attempts exceeded. Session invalidated.",
        400
      );
      return;
    }

    // Secure OTP validation via SHA-256 hash comparison
    const providedHash = crypto
      .createHash("sha256")
      .update(otp.trim())
      .digest("hex");

    if (providedHash !== session.otpHash) {
      const updatedAttempts = session.otpAttempts + 1;
      const attemptsLeft = session.maxOtpAttempts - updatedAttempts;

      await prisma.voucherRedemptionSession.update({
        where: { id: session.id },
        data: {
          otpAttempts: updatedAttempts,
          ...(attemptsLeft <= 0
            ? { status: RedemptionSessionStatus.EXPIRED }
            : {})
        }
      });

      await logAudit({
        employeeId,
        action:
          attemptsLeft <= 0
            ? "REDEMPTION_OTP_MAX_ATTEMPTS_EXCEEDED"
            : "REDEMPTION_OTP_FAILED",
        entityType: "VoucherRedemptionSession",
        entityId: String(session.id),
        details: {
          sessionId: session.id,
          attempts: updatedAttempts,
          attemptsLeft: Math.max(0, attemptsLeft)
        },
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });

      if (attemptsLeft <= 0) {
        errorResponse(
          res,
          "Maximum OTP attempts exceeded. Session invalidated.",
          400
        );
      } else {
        errorResponse(
          res,
          `Invalid OTP. ${attemptsLeft} attempt(s) remaining.`,
          400
        );
      }
      return;
    }

    // Database transaction guarantees atomic redemption
    const result = await prisma.$transaction(async (tx) => {
      /*
       * ATOMIC REDEMPTION TRANSACTION:
       * 1. Session status: SCANNED -> COMPLETED (conditional updateMany prevents concurrent race conditions)
       * 2. CustomerVoucher status: ACTIVE -> REDEEMED
       * 3. Voucher redeemedCount incremented (conditional on active and limit)
       */
      const sessionUpdate = await tx.voucherRedemptionSession.updateMany({
        where: {
          id: session.id,
          status: RedemptionSessionStatus.SCANNED
        },
        data: {
          status: RedemptionSessionStatus.COMPLETED,
          verifiedAt: now,
          redeemedAt: now,
          redeemedByEmployeeId: employeeId,
          otpHash: null,
          otpEncrypted: null
        }
      });

      if (sessionUpdate.count !== 1) {
        throw new Error("Redemption session has already been completed or is no longer valid");
      }

      const cvUpdate = await tx.customerVoucher.updateMany({
        where: {
          id: session.customerVoucherId,
          customerId: session.customerId,
          status: VoucherStatus.ACTIVE
        },
        data: {
          status: VoucherStatus.REDEEMED,
          redeemedAt: now
        }
      });

      if (cvUpdate.count !== 1) {
        throw new Error("Customer voucher has already been redeemed");
      }

      const voucher = await tx.voucher.findUnique({
        where: { id: session.voucherId }
      });

      if (!voucher || voucher.status !== VoucherStatus.ACTIVE) {
        throw new Error("Voucher is not active");
      }

      if (
        voucher.maxRedemptions !== null &&
        voucher.redeemedCount >= voucher.maxRedemptions
      ) {
        throw new Error("Voucher redemption limit has been reached");
      }

      const vUpdate = await tx.voucher.updateMany({
        where: {
          id: session.voucherId,
          status: VoucherStatus.ACTIVE,
          OR: [
            { maxRedemptions: null },
            { maxRedemptions: { gt: voucher.redeemedCount } }
          ]
        },
        data: {
          redeemedCount: { increment: 1 }
        }
      });

      if (vUpdate.count !== 1) {
        throw new Error("Voucher redemption limit has been reached");
      }

      if (
        voucher.maxRedemptions !== null &&
        voucher.redeemedCount + 1 >= voucher.maxRedemptions
      ) {
        await tx.voucher.update({
          where: { id: session.voucherId },
          data: { status: VoucherStatus.REDEEMED }
        });
      }

      // Record audit log within the same transaction
      await tx.auditLog.create({
        data: {
          employeeId,
          action: "VOUCHER_REDEEMED",
          entityType: "CustomerVoucher",
          entityId: String(session.customerVoucherId),
          details: {
            sessionId: session.id,
            voucherId: session.voucherId,
            customerVoucherId: session.customerVoucherId,
            customerId: session.customerId,
            voucherCode: voucher.code
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent")
        }
      });

      // Invalidate all lingering sessions for this customer voucher
      await tx.voucherRedemptionSession.updateMany({
        where: {
          customerVoucherId: session.customerVoucherId,
          id: { not: session.id },
          status: {
            in: [
              RedemptionSessionStatus.CREATED,
              RedemptionSessionStatus.SCANNED
            ]
          }
        },
        data: {
          status: RedemptionSessionStatus.CANCELLED
        }
      });

      // Invalidate any dynamic QR tokens for this token
      await tx.dynamicQrToken.updateMany({
        where: {
          token: session.sessionToken,
          status: { in: [QrStatus.PENDING, QrStatus.CONSUMED] }
        },
        data: {
          status: QrStatus.EXPIRED
        }
      });

      return {
        success: true,
        customerVoucherId: session.customerVoucherId,
        voucherId: voucher.id,
        code: voucher.code,
        name: voucher.name,
        title: voucher.name,
        type: voucher.type,
        value: voucher.value,
        status: "REDEEMED",
        customerVoucherStatus: "REDEEMED",
        isRedeemed: true,
        redeemedAt: now.toISOString(),
        customer: {
          id: session.customer.id,
          name: session.customer.name,
          phone: session.customer.phone
        },
        session: {
          id: session.id,
          status: RedemptionSessionStatus.COMPLETED
        }
      };
    });

    successResponse(res, result, "Voucher redeemed successfully");
  } catch (error) {
    if (error instanceof Error) {
      const message = error.message;
      if (
        message.includes("not found")
      ) {
        errorResponse(res, message, 404);
        return;
      }
      if (
        message.includes("already been redeemed") ||
        message.includes("already been completed")
      ) {
        errorResponse(res, message, 409);
        return;
      }
      if (
        message.includes("Invalid OTP") ||
        message.includes("expired") ||
        message.includes("exceeded") ||
        message.includes("not in SCANNED status") ||
        message.includes("limit has been reached")
      ) {
        errorResponse(res, message, 400);
        return;
      }
    }
    next(error);
  }
};

router.post(
  "/verify-otp",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_REDEEM),
  handleVerifyOtpAndRedeem
);

export default router;
