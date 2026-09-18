import { Router, NextFunction, Request, Response } from "express";
import { CustomerStatus, Permission, Prisma, Role, VoucherStatus, VoucherType } from "@prisma/client";
import { z } from "zod";
import jwt from "jsonwebtoken";

import { prisma } from "../config/prisma";
import {
  AuthenticatedRequest,
  authenticateEmployee,
  authenticateCustomerDevice,
  authorizeRole
} from "../middleware/auth";
import { authorizePermission } from "../middleware/permission";
import { logAudit } from "../utils/audit";
import {
  errorResponse,
  successResponse
} from "../utils/response";
import { formatCustomerVoucherItem } from "../utils/voucher";
import {
  uploadMemory,
  saveImageBuffer,
  removeImageFile
} from "../utils/upload";
import {
  handleCreateRedemptionSession,
  handleGetRedemptionSessionStatus,
  handleScanRedemptionQr,
  handleVerifyOtpAndRedeem
} from "./redemption.routes";

const router = Router();

const createVoucherSchema = z.object({
  code: z.string().trim().min(3).max(50),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  type: z.nativeEnum(VoucherType),
  value: z.number().nonnegative().optional(),
  maxRedemptions: z.number().int().positive().optional(),
  imageUrl: z.string().trim().nullable().optional(),
  startsAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional()
}).superRefine((data, ctx) => {
  if (
    data.type !== VoucherType.FREE_ITEM &&
    data.value === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "Value is required for this voucher type"
    });
  }

  if (
    data.type === VoucherType.PERCENTAGE &&
    data.value !== undefined &&
    data.value > 100
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "Percentage value cannot exceed 100"
    });
  }

  if (
    data.startsAt &&
    data.expiresAt &&
    data.expiresAt <= data.startsAt
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "expiresAt must be later than startsAt"
    });
  }
});

const voucherIdSchema = z.object({
  id: z.coerce.number().int().positive()
});

const updateVoucherSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  type: z.nativeEnum(VoucherType).optional(),
  value: z.number().nonnegative().nullable().optional(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
  imageUrl: z.string().trim().nullable().optional(),
  startsAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  status: z.nativeEnum(VoucherStatus).optional()
});

const issueVoucherSchema = z
  .object({
    voucherId: z.coerce.number().int().positive().optional(),
    voucher_id: z.coerce.number().int().positive().optional(),
    customerId: z.coerce.number().int().positive().optional(),
    customer_id: z.coerce.number().int().positive().optional(),
    customerIds: z.array(z.coerce.number().int().positive()).optional(),
    customer_ids: z.array(z.coerce.number().int().positive()).optional(),
    selectAll: z.boolean().optional(),
    select_all: z.boolean().optional(),
    excludeCustomerIds: z.array(z.coerce.number().int().positive()).optional(),
    exclude_customer_ids: z.array(z.coerce.number().int().positive()).optional()
  })
  .transform((data) => ({
    voucherId: data.voucherId ?? data.voucher_id,
    customerId: data.customerId ?? data.customer_id,
    customerIds: data.customerIds ?? data.customer_ids,
    selectAll: data.selectAll ?? data.select_all,
    excludeCustomerIds: data.excludeCustomerIds ?? data.exclude_customer_ids
  }))
  .refine(
    (data) =>
      data.customerId !== undefined ||
      (data.customerIds !== undefined && data.customerIds.length > 0) ||
      data.selectAll === true,
    {
      message: "Must provide customerId, non-empty customerIds, or selectAll: true"
    }
  );

const bulkIssueVoucherSchema = z
  .object({
    voucherId: z.coerce.number().int().positive().optional(),
    voucher_id: z.coerce.number().int().positive().optional(),
    customerId: z.coerce.number().int().positive().optional(),
    customer_id: z.coerce.number().int().positive().optional(),
    customerIds: z.array(z.coerce.number().int().positive()).optional(),
    customer_ids: z.array(z.coerce.number().int().positive()).optional(),
    selectAll: z.boolean().optional(),
    select_all: z.boolean().optional(),
    excludeCustomerIds: z.array(z.coerce.number().int().positive()).optional(),
    exclude_customer_ids: z.array(z.coerce.number().int().positive()).optional()
  })
  .refine(
    (data) => data.voucherId !== undefined || data.voucher_id !== undefined,
    {
      message: "Must provide voucherId or voucher_id"
    }
  )
  .transform((data) => ({
    voucherId: (data.voucherId ?? data.voucher_id) as number,
    customerId: data.customerId ?? data.customer_id,
    customerIds: data.customerIds ?? data.customer_ids,
    selectAll: data.selectAll ?? data.select_all,
    excludeCustomerIds: data.excludeCustomerIds ?? data.exclude_customer_ids
  }))
  .refine(
    (data) =>
      data.customerId !== undefined ||
      (data.customerIds !== undefined && data.customerIds.length > 0) ||
      data.selectAll === true,
    {
      message: "Must provide customerId, non-empty customerIds, or selectAll: true"
    }
  );

const redeemVoucherSchema = z.object({
  voucherId: z.number().int().positive()
});

const voucherListQuerySchema = z.object({
  status: z.nativeEnum(VoucherStatus).optional(),
  type: z.nativeEnum(VoucherType).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0)
});

/**
 * POST /create and POST /
 *
 * Create a new voucher.
 */
async function handleCreateVoucher(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      errorResponse(
        res,
        "Employee authentication required",
        401
      );
      return;
    }

    const data = createVoucherSchema.parse(req.body);

    const existingVoucher = await prisma.voucher.findUnique({
      where: {
        code: data.code
      }
    });

    if (existingVoucher) {
      errorResponse(
        res,
        "Voucher code already exists",
        409
      );
      return;
    }

    let imageUrl = data.imageUrl || null;
    if (req.file) {
      imageUrl = saveImageBuffer(req.file.buffer, "vouchers");
    }

    const now = new Date();

    const status =
      data.startsAt && data.startsAt > now
        ? VoucherStatus.ACTIVE
        : VoucherStatus.ACTIVE;

    const voucher = await prisma.voucher.create({
      data: {
        code: data.code,
        name: data.name,
        description: data.description,
        type: data.type,
        value:
          data.value !== undefined
            ? new Prisma.Decimal(data.value)
            : null,
        maxRedemptions: data.maxRedemptions,
        imageUrl,
        startsAt: data.startsAt,
        expiresAt: data.expiresAt,
        status
      }
    });

    await logAudit({
      employeeId: req.user.id,
      action: "VOUCHER_CREATED",
      entityType: "Voucher",
      entityId: String(voucher.id),
      details: {
        code: voucher.code,
        type: voucher.type,
        value: voucher.value?.toString() ?? null,
        maxRedemptions: voucher.maxRedemptions,
        imageUrl
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });

    successResponse(
      res,
      voucher,
      "Voucher created successfully",
      201
    );
  } catch (error) {
    next(error);
  }
}

/**
 * POST /upload-image
 *
 * Employee uploads a voucher image file.
 */
router.post(
  "/upload-image",
  authenticateEmployee,
  authorizePermission(
    Permission.VOUCHER_CREATE,
    Permission.VOUCHER_MANAGE
  ),
  uploadMemory.single("image"),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file) {
        errorResponse(res, "No image file uploaded", 400);
        return;
      }

      const imageUrl = saveImageBuffer(req.file.buffer, "vouchers");
      successResponse(res, { imageUrl }, "Voucher image uploaded successfully", 201);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/create",
  authenticateEmployee,
  authorizePermission(
    Permission.VOUCHER_CREATE,
    Permission.VOUCHER_MANAGE
  ),
  uploadMemory.single("image"),
  handleCreateVoucher
);

router.post(
  "/",
  authenticateEmployee,
  authorizePermission(
    Permission.VOUCHER_CREATE,
    Permission.VOUCHER_MANAGE
  ),
  uploadMemory.single("image"),
  handleCreateVoucher
);

/**
 * Handler for customer retrieving their own assigned vouchers.
 * Formats every voucher with full display, validity, and redemption metadata.
 */
export async function handleGetCustomerVouchers(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.device) {
      errorResponse(res, "Customer device authentication required", 401);
      return;
    }

    const requestedStatus =
      typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
    const onlyActive =
      requestedStatus === "ACTIVE" || req.path.includes("active");

    const customerVouchers = await prisma.customerVoucher.findMany({
      where: {
        customerId: req.device.customerId
      },
      include: {
        voucher: true
      },
      orderBy: {
        issuedAt: "desc"
      }
    });

    const allFormatted = customerVouchers.map(formatCustomerVoucherItem);
    const activeVouchers = allFormatted.filter((v) => v.status === "ACTIVE");
    const resultVouchers = onlyActive ? activeVouchers : allFormatted;

    res.status(200).json({
      success: true,
      message: "Customer vouchers retrieved successfully",
      data: resultVouchers,
      vouchers: resultVouchers,
      activeVouchers,
      customerVouchers: resultVouchers
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Customer views their issued vouchers.
 * Placed BEFORE /:id so it is never intercepted by parameter routing.
 */
router.get("/my-vouchers", authenticateCustomerDevice, handleGetCustomerVouchers);
router.get("/customer/my-vouchers", authenticateCustomerDevice, handleGetCustomerVouchers);
router.get("/mine", authenticateCustomerDevice, handleGetCustomerVouchers);
router.get("/customer", authenticateCustomerDevice, handleGetCustomerVouchers);
router.get("/active", authenticateCustomerDevice, handleGetCustomerVouchers);
router.get("/my-active-vouchers", authenticateCustomerDevice, handleGetCustomerVouchers);
router.get("/active-vouchers", authenticateCustomerDevice, handleGetCustomerVouchers);

/**
 * GET /
 *
 * Employee views vouchers.
 * Dual-purpose list endpoint:
 * - If Customer Device: Lists the customer's assigned vouchers.
 * - If Employee: Lists vouchers with pagination and permission checks.
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
        // Customer Device Token -> return customer vouchers
        return authenticateCustomerDevice(req, res, () =>
          handleGetCustomerVouchers(req, res, next)
        );
      }

      // Default: Employee Token -> verify employee & permission
      return authenticateEmployee(req, res, () => {
        return authorizePermission(
          Permission.VOUCHER_VIEW,
          Permission.VOUCHER_MANAGE
        )(req, res, async () => {
          try {
            const {
              status,
              type,
              limit,
              offset
            } = voucherListQuerySchema.parse(req.query);

            const where = {
              ...(status !== undefined ? { status } : {}),
              ...(type !== undefined ? { type } : {})
            };

            const [vouchers, total] =
              await prisma.$transaction([
                prisma.voucher.findMany({
                  where,
                  include: {
                    _count: {
                      select: {
                        customerVouchers: true
                      }
                    }
                  },
                  orderBy: {
                    createdAt: "desc"
                  },
                  skip: offset,
                  take: limit
                }),
                prisma.voucher.count({
                  where
                })
              ]);

            successResponse(
              res,
              {
                vouchers,
                pagination: {
                  total,
                  limit,
                  offset,
                  hasMore: offset + vouchers.length < total
                }
              },
              "Vouchers retrieved successfully"
            );
          } catch (error) {
            next(error);
          }
        });
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /:id
 *
 * Dual-purpose single voucher endpoint:
 * - If Customer Device: Retrieves customer's voucher details with full metadata & current status.
 * - If Employee: Retrieves voucher template details and assigned customer list.
 */
router.get(
  "/:id",
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

      // 1. Customer Device Token -> return customer's voucher details
      if (decoded && decoded.customerId && decoded.deviceId) {
        return authenticateCustomerDevice(req, res, async () => {
          try {
            const { id } = voucherIdSchema.parse(req.params);
            const customerId = req.device!.customerId;

            const customerVoucher = await prisma.customerVoucher.findFirst({
              where: {
                customerId,
                OR: [{ id }, { voucherId: id }]
              },
              include: {
                voucher: true
              }
            });

            if (!customerVoucher) {
              errorResponse(res, "Voucher not found", 404);
              return;
            }

            successResponse(
              res,
              formatCustomerVoucherItem(customerVoucher),
              "Voucher details retrieved successfully"
            );
          } catch (err) {
            next(err);
          }
        });
      }

      // 2. Default: Employee Token -> verify employee & permission
      return authenticateEmployee(req, res, () => {
        return authorizePermission(
          Permission.VOUCHER_VIEW,
          Permission.VOUCHER_MANAGE
        )(req, res, async () => {
          try {
            const { id } = voucherIdSchema.parse(req.params);

            const voucher = await prisma.voucher.findUnique({
              where: {
                id
              },
              include: {
                customerVouchers: {
                  include: {
                    customer: {
                      select: {
                        id: true,
                        name: true,
                        phone: true,
                        email: true
                      }
                    }
                  },
                  orderBy: {
                    issuedAt: "desc"
                  }
                }
              }
            });

            if (!voucher) {
              errorResponse(
                res,
                "Voucher not found",
                404
              );
              return;
            }

            successResponse(
              res,
              voucher,
              "Voucher retrieved successfully"
            );
          } catch (error) {
            next(error);
          }
        });
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /:id/image
 *
 * Employee uploads/replaces image for a specific voucher.
 */
router.post(
  "/:id/image",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_MANAGE),
  uploadMemory.single("image"),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file) {
        errorResponse(res, "No image file uploaded", 400);
        return;
      }

      const { id } = voucherIdSchema.parse(req.params);
      const voucher = await prisma.voucher.findUnique({ where: { id } });

      if (!voucher) {
        errorResponse(res, "Voucher not found", 404);
        return;
      }

      if (voucher.imageUrl) {
        removeImageFile(voucher.imageUrl);
      }

      const imageUrl = saveImageBuffer(req.file.buffer, "vouchers");

      const updated = await prisma.voucher.update({
        where: { id },
        data: { imageUrl }
      });

      await logAudit({
        employeeId: req.user!.id,
        action: "VOUCHER_IMAGE_UPDATED",
        entityType: "Voucher",
        entityId: String(voucher.id),
        details: { imageUrl },
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });

      successResponse(res, updated, "Voucher image updated successfully");
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /:id/image
 *
 * Employee removes image from a specific voucher.
 */
router.delete(
  "/:id/image",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_MANAGE),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = voucherIdSchema.parse(req.params);
      const voucher = await prisma.voucher.findUnique({ where: { id } });

      if (!voucher) {
        errorResponse(res, "Voucher not found", 404);
        return;
      }

      if (voucher.imageUrl) {
        removeImageFile(voucher.imageUrl);
      }

      const updated = await prisma.voucher.update({
        where: { id },
        data: { imageUrl: null }
      });

      await logAudit({
        employeeId: req.user!.id,
        action: "VOUCHER_IMAGE_REMOVED",
        entityType: "Voucher",
        entityId: String(voucher.id),
        details: {},
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });

      successResponse(res, updated, "Voucher image removed successfully");
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Handler for updating voucher details and optional photo.
 */
async function handleUpdateVoucher(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      errorResponse(res, "Employee authentication required", 401);
      return;
    }

    const { id } = voucherIdSchema.parse(req.params);
    const data = updateVoucherSchema.parse(req.body);

    const voucher = await prisma.voucher.findUnique({ where: { id } });
    if (!voucher) {
      errorResponse(res, "Voucher not found", 404);
      return;
    }

    let imageUrl = data.imageUrl !== undefined ? data.imageUrl : voucher.imageUrl;
    if (req.file) {
      if (voucher.imageUrl) {
        removeImageFile(voucher.imageUrl);
      }
      imageUrl = saveImageBuffer(req.file.buffer, "vouchers");
    } else if (data.imageUrl === null && voucher.imageUrl) {
      removeImageFile(voucher.imageUrl);
      imageUrl = null;
    }

    const updated = await prisma.voucher.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.value !== undefined ? { value: data.value !== null ? new Prisma.Decimal(data.value) : null } : {}),
        ...(data.maxRedemptions !== undefined ? { maxRedemptions: data.maxRedemptions } : {}),
        ...(data.startsAt !== undefined ? { startsAt: data.startsAt } : {}),
        ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        imageUrl
      }
    });

    await logAudit({
      employeeId: req.user.id,
      action: "VOUCHER_UPDATED",
      entityType: "Voucher",
      entityId: String(voucher.id),
      details: {
        code: voucher.code,
        changes: req.body
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });

    successResponse(res, updated, "Voucher updated successfully");
  } catch (error) {
    next(error);
  }
}

router.patch(
  "/:id",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_MANAGE),
  uploadMemory.single("image"),
  handleUpdateVoucher
);

router.put(
  "/:id",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_MANAGE),
  uploadMemory.single("image"),
  handleUpdateVoucher
);

/**
 * Helper function to issue vouchers to one or more customers.
 * Handles validation, duplicate checking, transactions, and audit logging.
 */
async function processVoucherIssuance(
  req: AuthenticatedRequest,
  res: Response,
  voucherId: number,
  body: z.infer<typeof issueVoucherSchema>
): Promise<void> {
  if (!req.user) {
    errorResponse(res, "Employee authentication required", 401);
    return;
  }

  const { customerId, customerIds, selectAll, excludeCustomerIds } = body;

  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId }
  });

  if (!voucher) {
    errorResponse(res, "Voucher not found", 404);
    return;
  }

  if (voucher.status !== VoucherStatus.ACTIVE) {
    errorResponse(res, "Voucher is not active", 400);
    return;
  }

  const now = new Date();
  if (voucher.expiresAt && voucher.expiresAt <= now) {
    errorResponse(res, "Voucher has already expired", 400);
    return;
  }

  if (
    voucher.maxRedemptions !== null &&
    voucher.redeemedCount >= voucher.maxRedemptions
  ) {
    errorResponse(res, "Voucher max redemptions limit has been reached", 400);
    return;
  }

  // 1. Resolve targeted customer IDs
  let targetCustomerIds: number[] = [];

  if (selectAll) {
    const approvedCustomers = await prisma.customer.findMany({
      where: { status: CustomerStatus.APPROVED },
      select: { id: true }
    });
    const excludedSet = new Set(excludeCustomerIds || []);
    targetCustomerIds = approvedCustomers
      .map((c) => c.id)
      .filter((id) => !excludedSet.has(id));
  } else if (customerIds && customerIds.length > 0) {
    targetCustomerIds = [...new Set(customerIds)];
  } else if (customerId !== undefined) {
    targetCustomerIds = [customerId];
  }

  if (targetCustomerIds.length === 0) {
    errorResponse(res, "No eligible customers selected", 400);
    return;
  }

  // 2. Fetch and validate approved customers
  const approvedCustomers = await prisma.customer.findMany({
    where: {
      id: { in: targetCustomerIds },
      status: CustomerStatus.APPROVED
    },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true
    }
  });

  // For single-customer issuance, preserve exact legacy errors
  if (customerId !== undefined) {
    const singleCustomer = await prisma.customer.findUnique({
      where: { id: customerId }
    });

    if (!singleCustomer) {
      errorResponse(res, "Customer not found", 404);
      return;
    }

    if (singleCustomer.status !== CustomerStatus.APPROVED) {
      errorResponse(res, "Voucher can only be issued to an approved customer", 400);
      return;
    }

    const existingCustomerVoucher = await prisma.customerVoucher.findUnique({
      where: {
        customerId_voucherId: {
          customerId,
          voucherId
        }
      }
    });

    if (existingCustomerVoucher) {
      errorResponse(
        res,
        "This voucher has already been issued to the customer",
        409
      );
      return;
    }
  }

  // 3. Find already assigned vouchers to prevent duplicate insertion
  const existingAssignments = await prisma.customerVoucher.findMany({
    where: {
      voucherId,
      customerId: { in: approvedCustomers.map((c) => c.id) }
    },
    select: { customerId: true }
  });

  const alreadyAssignedSet = new Set(
    existingAssignments.map((a) => a.customerId)
  );

  const customersToAssign = approvedCustomers.filter(
    (c) => !alreadyAssignedSet.has(c.id)
  );

  // 4. Create customer vouchers in transaction
  let createdVouchers: any[] = [];
  if (customersToAssign.length > 0) {
    createdVouchers = await prisma.$transaction(
      customersToAssign.map((customer) =>
        prisma.customerVoucher.create({
          data: {
            customerId: customer.id,
            voucherId,
            status: VoucherStatus.ACTIVE,
            issuedAt: now,
            expiresAt: voucher.expiresAt
          },
          include: {
            voucher: true,
            customer: {
              select: {
                id: true,
                name: true,
                phone: true,
                email: true
              }
            }
          }
        })
      )
    );
  }

  // 5. Audit logging
  await logAudit({
    employeeId: req.user.id,
    action: customerId !== undefined ? "VOUCHER_ISSUED" : "VOUCHER_BULK_ISSUED",
    entityType: "CustomerVoucher",
    entityId: String(voucher.id),
    details: {
      voucherId,
      voucherCode: voucher.code,
      totalTargeted: targetCustomerIds.length,
      assignedCount: createdVouchers.length,
      alreadyAssignedCount: alreadyAssignedSet.size,
      skippedCustomerIds: Array.from(alreadyAssignedSet)
    },
    ipAddress: req.ip,
    userAgent: req.get("user-agent")
  });

  // 6. Response
  if (customerId !== undefined) {
    // Single customer request -> return formatted CustomerVoucher object directly
    const formatted = formatCustomerVoucherItem(createdVouchers[0]);
    successResponse(
      res,
      formatted,
      "Voucher issued successfully",
      201
    );
    return;
  }

  // Multi-customer / bulk request -> return comprehensive summary
  const formattedAssigned = createdVouchers.map(formatCustomerVoucherItem);
  successResponse(
    res,
    {
      totalTargeted: targetCustomerIds.length,
      assignedCount: createdVouchers.length,
      alreadyAssignedCount: alreadyAssignedSet.size,
      skippedCustomerIds: Array.from(alreadyAssignedSet),
      assignedCustomerIds: createdVouchers.map((cv) => cv.customerId),
      assignedVouchers: formattedAssigned
    },
    `Voucher assigned successfully to ${createdVouchers.length} customer(s)`,
    201
  );
}

/**
 * POST /issue
 *
 * Employee issues a voucher (voucherId in body).
 */
router.post(
  "/issue",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_MANAGE),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const body = bulkIssueVoucherSchema.parse(req.body);
      await processVoucherIssuance(req, res, body.voucherId, body);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /:id/issue
 *
 * Employee issues a voucher to a customer (or multiple customers via bulk payload).
 */
router.post(
  "/:id/issue",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_MANAGE),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { id: voucherId } = voucherIdSchema.parse(req.params);
      const body = issueVoucherSchema.parse(req.body);
      await processVoucherIssuance(req, res, voucherId, body);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /:id/assign
 *
 * Alias for employee issuing a voucher to a customer.
 */
router.post(
  "/:id/assign",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_MANAGE),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { id: voucherId } = voucherIdSchema.parse(req.params);
      const body = issueVoucherSchema.parse(req.body);
      await processVoucherIssuance(req, res, voucherId, body);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /bulk-issue
 *
 * Bulk voucher assignment endpoint.
 */
router.post(
  "/bulk-issue",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_MANAGE),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const body = bulkIssueVoucherSchema.parse(req.body);
      await processVoucherIssuance(req, res, body.voucherId, body);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /redeem
 *
 * Customer redeems an issued voucher.
 *
 * The customer-voucher status is changed atomically.
 * The voucher's redeemedCount is also incremented only when
 * the voucher is still active and has not reached its limit.
 */
router.post(
  "/redeem",
  authenticateCustomerDevice,
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.device) {
        errorResponse(
          res,
          "Customer device authentication required",
          401
        );
        return;
      }

      const { voucherId } =
        redeemVoucherSchema.parse(req.body);

      const customerId = req.device.customerId;
      const now = new Date();

      const result = await prisma.$transaction(
        async (tx) => {
          const customerVoucher =
            await tx.customerVoucher.findUnique({
              where: {
                customerId_voucherId: {
                  customerId,
                  voucherId
                }
              },
              include: {
                voucher: true
              }
            });

          if (!customerVoucher) {
            throw new Error(
              "Voucher has not been issued to this customer"
            );
          }

          if (
            customerVoucher.status !==
            VoucherStatus.ACTIVE
          ) {
            throw new Error(
              "Customer voucher is not active"
            );
          }

          if (
            customerVoucher.expiresAt &&
            customerVoucher.expiresAt <= now
          ) {
            await tx.customerVoucher.update({
              where: {
                id: customerVoucher.id
              },
              data: {
                status: VoucherStatus.EXPIRED
              }
            });

            throw new Error(
              "Customer voucher has expired"
            );
          }

          const voucher = customerVoucher.voucher;

          if (voucher.status !== VoucherStatus.ACTIVE) {
            throw new Error(
              "Voucher is not active"
            );
          }

          if (
            voucher.startsAt &&
            voucher.startsAt > now
          ) {
            throw new Error(
              "Voucher is not active yet"
            );
          }

          if (
            voucher.expiresAt &&
            voucher.expiresAt <= now
          ) {
            await tx.voucher.update({
              where: {
                id: voucher.id
              },
              data: {
                status: VoucherStatus.EXPIRED
              }
            });

            await tx.customerVoucher.update({
              where: {
                id: customerVoucher.id
              },
              data: {
                status: VoucherStatus.EXPIRED
              }
            });

            throw new Error(
              "Voucher has expired"
            );
          }

          const customerVoucherUpdate =
            await tx.customerVoucher.updateMany({
              where: {
                id: customerVoucher.id,
                customerId,
                status: VoucherStatus.ACTIVE
              },
              data: {
                status: VoucherStatus.REDEEMED,
                redeemedAt: now
              }
            });

          if (customerVoucherUpdate.count !== 1) {
            throw new Error(
              "Voucher has already been redeemed"
            );
          }

          const voucherUpdate =
            await tx.voucher.updateMany({
              where: {
                id: voucher.id,
                status: VoucherStatus.ACTIVE,
                OR: [
                  {
                    maxRedemptions: null
                  },
                  {
                    maxRedemptions: {
                      gt: voucher.redeemedCount
                    }
                  }
                ]
              },
              data: {
                redeemedCount: {
                  increment: 1
                }
              }
            });

          if (voucherUpdate.count !== 1) {
            throw new Error(
              "Voucher redemption limit has been reached"
            );
          }

          if (
            voucher.maxRedemptions !== null &&
            voucher.redeemedCount + 1 >=
              voucher.maxRedemptions
          ) {
            await tx.voucher.update({
              where: {
                id: voucher.id
              },
              data: {
                status: VoucherStatus.REDEEMED
              }
            });
          }

          return {
            customerVoucherId:
              customerVoucher.id,
            voucherId: voucher.id,
            code: voucher.code,
            name: voucher.name,
            type: voucher.type,
            value: voucher.value,
            redeemedAt: now
          };
        }
      );

      successResponse(
        res,
        result,
        "Voucher redeemed successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /:id/revoke
 *
 * Employee revokes a voucher.
 */
router.post(
  "/:id/revoke",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_MANAGE),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        errorResponse(
          res,
          "Employee authentication required",
          401
        );
        return;
      }

      const { id } =
        voucherIdSchema.parse(req.params);

      const voucher = await prisma.voucher.findUnique({
        where: {
          id
        }
      });

      if (!voucher) {
        errorResponse(
          res,
          "Voucher not found",
          404
        );
        return;
      }

      if (voucher.status === VoucherStatus.REVOKED) {
        errorResponse(
          res,
          "Voucher is already revoked",
          400
        );
        return;
      }

      const updatedVoucher =
        await prisma.$transaction(async (tx) => {
          const updated =
            await tx.voucher.update({
              where: {
                id: voucher.id
              },
              data: {
                status: VoucherStatus.REVOKED
              }
            });

          await tx.customerVoucher.updateMany({
            where: {
              voucherId: voucher.id,
              status: VoucherStatus.ACTIVE
            },
            data: {
              status: VoucherStatus.REVOKED
            }
          });

          return updated;
        });

      await logAudit({
        employeeId: req.user.id,
        action: "VOUCHER_REVOKED",
        entityType: "Voucher",
        entityId: String(voucher.id),
        details: {
          voucherId: voucher.id,
          code: voucher.code
        },
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });

      successResponse(
        res,
        updatedVoucher,
        "Voucher revoked successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /:id/redeem
 * POST /:voucherId/redemption-session
 * POST /:id/redemption-session
 * Customer creates a short-lived redemption session with GPS pre-check
 * (Compatible with Android ApiService.kt: POST /vouchers/{id}/redeem)
 */
router.post(
  "/:id/redeem",
  authenticateCustomerDevice,
  handleCreateRedemptionSession
);

router.post(
  "/:voucherId/redemption-session",
  authenticateCustomerDevice,
  handleCreateRedemptionSession
);

router.post(
  "/:id/redemption-session",
  authenticateCustomerDevice,
  handleCreateRedemptionSession
);

/**
 * GET /redemption-session/:sessionId and GET /redemption-session/:token
 * Polling endpoint for Android customer app to track redemption session state
 * (Compatible with Android ApiService.kt: GET /vouchers/redemption-session/{sessionId})
 */
router.get(
  "/redemption-session/:sessionId",
  authenticateCustomerDevice,
  handleGetRedemptionSessionStatus
);

router.get(
  "/redemption-session/:token",
  authenticateCustomerDevice,
  handleGetRedemptionSessionStatus
);

router.get(
  "/:voucherId/redemption-session",
  authenticateCustomerDevice,
  handleGetRedemptionSessionStatus
);

router.get(
  "/:id/redemption-session",
  authenticateCustomerDevice,
  handleGetRedemptionSessionStatus
);

router.get(
  "/:id/session",
  authenticateCustomerDevice,
  handleGetRedemptionSessionStatus
);

/**
 * Admin Web Panel QR scan & redemption endpoints
 * Supports both /verify-qr & /redeem, and /redemption/scan & /redemption/verify-otp
 */
router.post(
  "/verify-qr",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_REDEEM),
  handleScanRedemptionQr
);

router.post(
  "/redemption/scan",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_REDEEM),
  handleScanRedemptionQr
);

router.post(
  "/redeem",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_REDEEM),
  handleVerifyOtpAndRedeem
);

router.post(
  "/redemption/verify-otp",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_REDEEM),
  handleVerifyOtpAndRedeem
);

export default router;