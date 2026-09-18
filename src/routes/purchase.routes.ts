import { Router, Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { Permission, Prisma } from "@prisma/client";

import { prisma } from "../config/prisma";
import {
  AuthenticatedRequest,
  authenticateCustomerDevice,
  authenticateEmployee
} from "../middleware/auth";
import { authorizePermission } from "../middleware/permission";
import { errorResponse, successResponse } from "../utils/response";
import { logAudit } from "../utils/audit";

const router = Router();

const createPurchaseSchema = z.object({
  customerId: z.coerce.number().int().positive(),
  amount: z.number().positive(),
  pointsEarned: z.number().int().nonnegative().optional(),
  description: z.string().trim().max(255).optional(),
  referenceNo: z.string().trim().max(100).optional()
});

const purchaseQuerySchema = z.object({
  customerId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0)
});

/**
 * Format a Purchase record for mobile Android and Admin consumption.
 */
function formatPurchaseItem(p: any) {
  return {
    id: p.id,
    orderNumber: p.referenceNo || `ORD-${p.id}`,
    referenceNo: p.referenceNo || `ORD-${p.id}`,
    amount: Number(p.amount),
    points: p.pointsEarned ?? 0,
    pointsEarned: p.pointsEarned ?? 0,
    saved: 0.0,
    createdAt: (p.purchasedAt || p.createdAt).toISOString(),
    purchasedAt: (p.purchasedAt || p.createdAt).toISOString(),
    summary: p.description || "Cafe Order",
    description: p.description || "Cafe Order",
    customerId: p.customerId,
    customer: p.customer
      ? {
          id: p.customer.id,
          name: p.customer.name,
          phone: p.customer.phone
        }
      : undefined
  };
}

/**
 * Handler for Customer Device retrieving their purchase history.
 */
async function handleCustomerPurchases(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.device) {
      errorResponse(res, "Customer device authentication required", 401);
      return;
    }

    const purchases = await prisma.purchase.findMany({
      where: {
        customerId: req.device.customerId
      },
      orderBy: {
        purchasedAt: "desc"
      }
    });

    const formatted = purchases.map(formatPurchaseItem);

    res.status(200).json({
      success: true,
      message: "Purchases retrieved successfully",
      data: {
        purchases: formatted
      },
      purchases: formatted
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Handler for Employees retrieving paginated purchases list.
 */
async function handleEmployeePurchases(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { customerId, limit, offset } = purchaseQuerySchema.parse(req.query);

    const where: Prisma.PurchaseWhereInput = {
      ...(customerId !== undefined ? { customerId } : {})
    };

    const [purchases, total] = await prisma.$transaction([
      prisma.purchase.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              phone: true
            }
          }
        },
        orderBy: {
          purchasedAt: "desc"
        },
        skip: offset,
        take: limit
      }),
      prisma.purchase.count({ where })
    ]);

    const formatted = purchases.map(formatPurchaseItem);

    successResponse(
      res,
      {
        purchases: formatted,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + purchases.length < total
        }
      },
      "Purchases retrieved successfully"
    );
  } catch (error) {
    next(error);
  }
}

/**
 * GET /purchases
 *
 * Dual-purpose list endpoint:
 * - If Customer Device: returns customer's purchases for History screen
 * - If Employee: returns paginated purchases list
 */
router.get(
  "/",
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        errorResponse(res, "Authentication required", 401);
        return;
      }
      const token = authHeader.substring(7);
      const decoded = jwt.decode(token) as any;

      if (decoded && decoded.customerId && decoded.deviceId) {
        return authenticateCustomerDevice(req, res, () =>
          handleCustomerPurchases(req, res, next)
        );
      }

      return authenticateEmployee(req, res, () => {
        return authorizePermission(
          Permission.PURCHASE_VIEW,
          Permission.PURCHASE_MANAGE
        )(req, res, () => handleEmployeePurchases(req, res, next));
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /purchases
 *
 * Employee creates a new customer purchase.
 */
router.post(
  "/",
  authenticateEmployee,
  authorizePermission(
    Permission.PURCHASE_CREATE,
    Permission.PURCHASE_MANAGE
  ),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        errorResponse(res, "Employee authentication required", 401);
        return;
      }

      const data = createPurchaseSchema.parse(req.body);

      const customer = await prisma.customer.findUnique({
        where: { id: data.customerId }
      });

      if (!customer) {
        errorResponse(res, "Customer not found", 404);
        return;
      }

      const purchase = await prisma.purchase.create({
        data: {
          customerId: data.customerId,
          amount: new Prisma.Decimal(data.amount),
          pointsEarned: data.pointsEarned ?? Math.floor(data.amount / 10),
          description: data.description,
          referenceNo: data.referenceNo
        }
      });

      await logAudit({
        employeeId: req.user.id,
        action: "PURCHASE_CREATED",
        entityType: "Purchase",
        entityId: String(purchase.id),
        details: {
          customerId: data.customerId,
          amount: data.amount,
          pointsEarned: purchase.pointsEarned
        },
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });

      const formatted = formatPurchaseItem(purchase);
      successResponse(res, formatted, "Purchase recorded successfully", 201);
    } catch (error) {
      next(error);
    }
  }
);

export default router;

