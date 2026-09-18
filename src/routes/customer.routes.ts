import { Router, NextFunction, Request, Response } from "express";
import { CustomerStatus, Permission, Role } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../config/prisma";
import {
  AuthenticatedRequest,
  authenticateEmployee,
  authenticateCustomerDevice
} from "../middleware/auth";
import { authorizePermission } from "../middleware/permission";
import { logAudit } from "../utils/audit";
import {
  errorResponse,
  successResponse
} from "../utils/response";
import { formatCustomerVoucherItem } from "../utils/voucher";

const router = Router();

const registerCustomerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(7).max(20),
  email: z
    .string()
    .trim()
    .email()
    .optional()
    .or(z.literal(""))
});

const customerIdSchema = z.object({
  id: z.coerce.number().int().positive()
});

const customerListQuerySchema = z.object({
  status: z
    .preprocess(
      (val) => (val === "ACTIVE" ? CustomerStatus.APPROVED : val),
      z.enum([
        CustomerStatus.PENDING,
        CustomerStatus.APPROVED,
        CustomerStatus.REJECTED,
        CustomerStatus.SUSPENDED
      ])
    )
    .optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0)
});

const rejectCustomerSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional()
});

const updateCustomerProfileSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  email: z.string().trim().email().optional().or(z.literal("")),
  dateOfBirth: z.string().optional()
});

/**
 * POST /register
 *
 * Public customer registration.
 */
router.post(
  "/register",
  async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const data = registerCustomerSchema.parse(req.body);

      const email =
        data.email && data.email.length > 0
          ? data.email
          : undefined;

      const existingCustomerByPhone =
        await prisma.customer.findUnique({
          where: {
            phone: data.phone
          }
        });

      if (existingCustomerByPhone) {
        errorResponse(
          res,
          "A customer with this phone number already exists",
          409
        );
        return;
      }

      if (email) {
        const existingCustomerByEmail =
          await prisma.customer.findUnique({
            where: {
              email
            }
          });

        if (existingCustomerByEmail) {
          errorResponse(
            res,
            "A customer with this email already exists",
            409
          );
          return;
        }
      }

      const customer = await prisma.customer.create({
        data: {
          name: data.name,
          phone: data.phone,
          email,
          status: CustomerStatus.PENDING
        },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          status: true,
          createdAt: true
        }
      });

      successResponse(
        res,
        customer,
        "Customer registration submitted for approval",
        201
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /pending
 *
 * Employee views customers waiting for approval.
 */
router.get(
  "/pending",
  authenticateEmployee,
  authorizePermission(
    Permission.CUSTOMER_VIEW,
    Permission.CUSTOMER_MANAGE
  ),
  async (
    _req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const customers = await prisma.customer.findMany({
        where: {
          status: CustomerStatus.PENDING
        },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          status: true,
          createdAt: true,
          updatedAt: true
        },
        orderBy: {
          createdAt: "asc"
        }
      });

      successResponse(
        res,
        customers,
        "Pending customers retrieved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /
 *
 * Employee views customers with optional filtering.
 */
router.get(
  "/",
  authenticateEmployee,
  authorizePermission(
    Permission.CUSTOMER_VIEW,
    Permission.CUSTOMER_MANAGE
  ),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const {
        status,
        search,
        limit,
        offset
      } = customerListQuerySchema.parse(req.query);

      const where = {
        ...(status !== undefined
          ? {
              status
            }
          : {}),
        ...(search
          ? {
              OR: [
                {
                  name: {
                    contains: search,
                    mode: "insensitive" as const
                  }
                },
                {
                  phone: {
                    contains: search,
                    mode: "insensitive" as const
                  }
                },
                {
                  email: {
                    contains: search,
                    mode: "insensitive" as const
                  }
                }
              ]
            }
          : {})
      };

      const [customers, total] = await prisma.$transaction([
        prisma.customer.findMany({
          where,
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            status: true,
            approvedAt: true,
            rejectedAt: true,
            createdAt: true,
            updatedAt: true,
            _count: {
              select: {
                customerVouchers: true,
                devices: true
              }
            }
          },
          orderBy: {
            createdAt: "desc"
          },
          skip: offset,
          take: limit
        }),
        prisma.customer.count({ where })
      ]);

      const formattedCustomers = customers.map((c) => ({
        ...c,
        membership: "Classic Member",
        membershipType: "Classic Member"
      }));

      successResponse(
        res,
        {
          customers: formattedCustomers,
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + customers.length < total
          }
        },
        "Customers retrieved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Handler for customer retrieving their own profile.
 */
export async function handleGetMyCustomerProfile(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.device) {
      errorResponse(
        res,
        "Customer device authentication required",
        401
      );
      return;
    }

    const customer = await prisma.customer.findUnique({
      where: {
        id: req.device.customerId
      },
      include: {
        devices: {
          where: {
            id: req.device.id
          },
          select: {
            id: true,
            deviceId: true,
            deviceName: true,
            platform: true,
            status: true,
            approvedAt: true,
            createdAt: true
          }
        },
        customerVouchers: {
          include: {
            voucher: true
          },
          orderBy: {
            issuedAt: "desc"
          }
        }
      }
    });

    if (!customer) {
      errorResponse(
        res,
        "Customer not found",
        404
      );
      return;
    }

    const [purchasePointsAgg, loyaltyPointsAgg, activeBenefits] = await Promise.all([
      prisma.purchase.aggregate({
        where: { customerId: req.device.customerId },
        _sum: { pointsEarned: true }
      }),
      prisma.loyaltyPoint.aggregate({
        where: { customerId: req.device.customerId },
        _sum: { points: true }
      }),
      prisma.benefit.findMany({
        where: { active: true },
        orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }]
      })
    ]);

    const calculatedPoints =
      (purchasePointsAgg._sum.pointsEarned ?? 0) + (loyaltyPointsAgg._sum.points ?? 0);

    const formattedVouchers = customer.customerVouchers.map(formatCustomerVoucherItem);
    const activeVouchers = formattedVouchers.filter((v) => v.status === "ACTIVE");

    const profile = {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      status: customer.status,
      tier: "CLASSIC MEMBER",
      membership: "Classic Member",
      membershipType: "Classic Member",
      points: calculatedPoints,
      approvedAt: customer.approvedAt,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
      devices: customer.devices,
      customerVouchers: formattedVouchers,
      vouchers: formattedVouchers,
      activeVouchers,
      benefits: activeBenefits
    };

    res.status(200).json({
      success: true,
      message: "Customer profile retrieved successfully",
      data: {
        customer: profile,
        ...profile
      },
      customer: profile,
      profile: profile,
      vouchers: formattedVouchers,
      activeVouchers,
      customerVouchers: formattedVouchers,
      benefits: activeBenefits
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Handler for customer updating their own profile (name, email).
 * Compatible with Android ApiService.kt: PATCH /customers/profile/me
 */
export async function handleUpdateMyCustomerProfile(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.device) {
      errorResponse(res, "Customer device authentication required", 401);
      return;
    }

    const { name, email } = updateCustomerProfileSchema.parse(req.body);

    const updateData: { name?: string; email?: string | null } = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email.length > 0 ? email : null;

    const updated = await prisma.customer.update({
      where: { id: req.device.customerId },
      data: updateData,
      include: {
        devices: {
          orderBy: {
            createdAt: "desc"
          }
        },
        customerVouchers: {
          include: {
            voucher: true
          },
          orderBy: {
            issuedAt: "desc"
          }
        }
      }
    });

    const [purchasePointsAgg, loyaltyPointsAgg, activeBenefits] = await Promise.all([
      prisma.purchase.aggregate({
        where: { customerId: req.device.customerId },
        _sum: { pointsEarned: true }
      }),
      prisma.loyaltyPoint.aggregate({
        where: { customerId: req.device.customerId },
        _sum: { points: true }
      }),
      prisma.benefit.findMany({
        where: { active: true },
        orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }]
      })
    ]);

    const calculatedPoints =
      (purchasePointsAgg._sum.pointsEarned ?? 0) + (loyaltyPointsAgg._sum.points ?? 0);

    const formattedVouchers = updated.customerVouchers.map(formatCustomerVoucherItem);
    const activeVouchers = formattedVouchers.filter((v) => v.status === "ACTIVE");

    const profile = {
      id: updated.id,
      name: updated.name,
      phone: updated.phone,
      email: updated.email,
      status: updated.status,
      tier: "CLASSIC MEMBER",
      membership: "Classic Member",
      membershipType: "Classic Member",
      points: calculatedPoints,
      approvedAt: updated.approvedAt,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      devices: updated.devices,
      customerVouchers: formattedVouchers,
      vouchers: formattedVouchers,
      activeVouchers,
      benefits: activeBenefits
    };

    res.status(200).json({
      success: true,
      message: "Customer profile updated successfully",
      data: {
        customer: profile,
        ...profile
      },
      customer: profile,
      profile: profile,
      vouchers: formattedVouchers,
      activeVouchers,
      customerVouchers: formattedVouchers,
      benefits: activeBenefits
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Handler for customer retrieving their own vouchers from /customers endpoints.
 */
export async function handleGetCustomerOwnVouchers(
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
 * Customer profile & vouchers routes.
 * Placed BEFORE /:id so they are never intercepted by parameter routing.
 */
router.get("/profile/me", authenticateCustomerDevice, handleGetMyCustomerProfile);
router.get("/me", authenticateCustomerDevice, handleGetMyCustomerProfile);
router.get("/profile", authenticateCustomerDevice, handleGetMyCustomerProfile);
router.patch("/profile/me", authenticateCustomerDevice, handleUpdateMyCustomerProfile);
router.patch("/me", authenticateCustomerDevice, handleUpdateMyCustomerProfile);
router.patch("/profile", authenticateCustomerDevice, handleUpdateMyCustomerProfile);
router.get("/my-vouchers", authenticateCustomerDevice, handleGetCustomerOwnVouchers);
router.get("/vouchers", authenticateCustomerDevice, handleGetCustomerOwnVouchers);
router.get("/me/vouchers", authenticateCustomerDevice, handleGetCustomerOwnVouchers);
router.get("/profile/me/vouchers", authenticateCustomerDevice, handleGetCustomerOwnVouchers);
router.get("/active-vouchers", authenticateCustomerDevice, handleGetCustomerOwnVouchers);
router.get("/my-active-vouchers", authenticateCustomerDevice, handleGetCustomerOwnVouchers);
router.get("/profile/me/active-vouchers", authenticateCustomerDevice, handleGetCustomerOwnVouchers);

/**
 * GET /:id
 *
 * Employee views a single customer.
 */
router.get(
  "/:id",
  authenticateEmployee,
  authorizePermission(
    Permission.CUSTOMER_VIEW,
    Permission.CUSTOMER_MANAGE
  ),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { id } = customerIdSchema.parse(req.params);

      const customer = await prisma.customer.findUnique({
        where: {
          id
        },
        include: {
          devices: {
            orderBy: {
              createdAt: "desc"
            }
          },
          customerVouchers: {
            include: {
              voucher: true
            },
            orderBy: {
              issuedAt: "desc"
            }
          }
        }
      });

      if (!customer) {
        errorResponse(
          res,
          "Customer not found",
          404
        );
        return;
      }

      const formattedVouchers = customer.customerVouchers.map(formatCustomerVoucherItem);

      const customerDetails = {
        ...customer,
        membership: "Classic Member",
        membershipType: "Classic Member",
        customerVouchers: formattedVouchers,
        vouchers: formattedVouchers
      };

      res.status(200).json({
        success: true,
        message: "Customer retrieved successfully",
        data: customerDetails,
        customer: customerDetails,
        vouchers: formattedVouchers,
        customerVouchers: formattedVouchers
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /:id/approve
 *
 * Employee approves a pending customer.
 */
router.post(
  "/:id/approve",
  authenticateEmployee,
  authorizePermission(Permission.CUSTOMER_MANAGE),
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

      const { id } = customerIdSchema.parse(req.params);

      const customer = await prisma.customer.findUnique({
        where: {
          id
        }
      });

      if (!customer) {
        errorResponse(
          res,
          "Customer not found",
          404
        );
        return;
      }

      if (customer.status !== CustomerStatus.PENDING) {
        errorResponse(
          res,
          "Only pending customers can be approved",
          400
        );
        return;
      }

      const approvedAt = new Date();

      const updatedCustomer =
        await prisma.customer.update({
          where: {
            id: customer.id
          },
          data: {
            status: CustomerStatus.APPROVED,
            approvedAt,
            rejectedAt: null
          },
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            status: true,
            approvedAt: true,
            rejectedAt: true,
            createdAt: true,
            updatedAt: true
          }
        });

      await logAudit({
        employeeId: req.user.id,
        action: "CUSTOMER_APPROVED",
        entityType: "Customer",
        entityId: String(customer.id),
        details: {
          customerId: customer.id,
          phone: customer.phone
        },
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });

      successResponse(
        res,
        updatedCustomer,
        "Customer approved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /:id/reject
 *
 * Employee rejects a pending customer.
 */
router.post(
  "/:id/reject",
  authenticateEmployee,
  authorizePermission(Permission.CUSTOMER_MANAGE),
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

      const { id } = customerIdSchema.parse(req.params);
      const { reason } =
        rejectCustomerSchema.parse(req.body);

      const customer = await prisma.customer.findUnique({
        where: {
          id
        }
      });

      if (!customer) {
        errorResponse(
          res,
          "Customer not found",
          404
        );
        return;
      }

      if (customer.status !== CustomerStatus.PENDING) {
        errorResponse(
          res,
          "Only pending customers can be rejected",
          400
        );
        return;
      }

      const updatedCustomer =
        await prisma.customer.update({
          where: {
            id: customer.id
          },
          data: {
            status: CustomerStatus.REJECTED,
            rejectedAt: new Date(),
            approvedAt: null
          },
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            status: true,
            approvedAt: true,
            rejectedAt: true,
            createdAt: true,
            updatedAt: true
          }
        });

      await logAudit({
        employeeId: req.user.id,
        action: "CUSTOMER_REJECTED",
        entityType: "Customer",
        entityId: String(customer.id),
        details: {
          customerId: customer.id,
          phone: customer.phone,
          reason
        },
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });

      successResponse(
        res,
        updatedCustomer,
        "Customer rejected successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /:id/suspend
 *
 * Employee suspends an approved customer.
 */
router.post(
  "/:id/suspend",
  authenticateEmployee,
  authorizePermission(Permission.CUSTOMER_MANAGE),
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

      const { id } = customerIdSchema.parse(req.params);

      const customer = await prisma.customer.findUnique({
        where: {
          id
        }
      });

      if (!customer) {
        errorResponse(
          res,
          "Customer not found",
          404
        );
        return;
      }

      if (customer.status !== CustomerStatus.APPROVED) {
        errorResponse(
          res,
          "Only approved customers can be suspended",
          400
        );
        return;
      }

      const updatedCustomer =
        await prisma.$transaction(async (tx) => {
          const updated =
            await tx.customer.update({
              where: {
                id: customer.id
              },
              data: {
                status: CustomerStatus.SUSPENDED
              },
              select: {
                id: true,
                name: true,
                phone: true,
                email: true,
                status: true,
                approvedAt: true,
                rejectedAt: true,
                createdAt: true,
                updatedAt: true
              }
            });

          await tx.device.updateMany({
            where: {
              customerId: customer.id,
              status: "ACTIVE"
            },
            data: {
              status: "REVOKED",
              revokedAt: new Date()
            }
          });

          return updated;
        });

      await logAudit({
        employeeId: req.user.id,
        action: "CUSTOMER_SUSPENDED",
        entityType: "Customer",
        entityId: String(customer.id),
        details: {
          customerId: customer.id,
          phone: customer.phone
        },
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });

      successResponse(
        res,
        updatedCustomer,
        "Customer suspended successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /:id/reactivate
 *
 * Employee reactivates a suspended customer.
 */
router.post(
  "/:id/reactivate",
  authenticateEmployee,
  authorizePermission(Permission.CUSTOMER_MANAGE),
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

      const { id } = customerIdSchema.parse(req.params);

      const customer = await prisma.customer.findUnique({
        where: {
          id
        }
      });

      if (!customer) {
        errorResponse(
          res,
          "Customer not found",
          404
        );
        return;
      }

      if (customer.status !== CustomerStatus.SUSPENDED) {
        errorResponse(
          res,
          "Only suspended customers can be reactivated",
          400
        );
        return;
      }

      const updatedCustomer =
        await prisma.customer.update({
          where: {
            id: customer.id
          },
          data: {
            status: CustomerStatus.APPROVED
          },
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            status: true,
            approvedAt: true,
            rejectedAt: true,
            createdAt: true,
            updatedAt: true
          }
        });

      await logAudit({
        employeeId: req.user.id,
        action: "CUSTOMER_REACTIVATED",
        entityType: "Customer",
        entityId: String(customer.id),
        details: {
          customerId: customer.id,
          phone: customer.phone
        },
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });

      successResponse(
        res,
        updatedCustomer,
        "Customer reactivated successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);


/**
 * GET /:id/vouchers
 *
 * Employee views all vouchers assigned to a customer.
 */
router.get(
  "/:id/vouchers",
  authenticateEmployee,
  authorizePermission(
    Permission.CUSTOMER_VIEW,
    Permission.VOUCHER_VIEW
  ),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { id } = customerIdSchema.parse(req.params);

      const customer = await prisma.customer.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          phone: true,
          status: true
        }
      });

      if (!customer) {
        errorResponse(res, "Customer not found", 404);
        return;
      }

      const customerVouchers = await prisma.customerVoucher.findMany({
        where: {
          customerId: id
        },
        include: {
          voucher: true
        },
        orderBy: {
          issuedAt: "desc"
        }
      });

      const formattedVouchers = customerVouchers.map(formatCustomerVoucherItem);

      successResponse(
        res,
        {
          customer: {
            ...customer,
            membership: "Classic Member",
            membershipType: "Classic Member"
          },
          vouchers: formattedVouchers,
          customerVouchers: formattedVouchers
        },
        "Customer vouchers retrieved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Handler for issuing a voucher to a customer directly from customer routes.
 */
async function handleIssueVoucherToCustomer(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      errorResponse(res, "Employee authentication required", 401);
      return;
    }

    const { id: customerId } = customerIdSchema.parse(req.params);
    const { voucherId } = z
      .object({
        voucherId: z.coerce.number().int().positive().optional(),
        voucher_id: z.coerce.number().int().positive().optional()
      })
      .transform((d) => ({
        voucherId: d.voucherId ?? d.voucher_id
      }))
      .refine((d) => d.voucherId !== undefined, {
        message: "Must provide voucherId or voucher_id"
      })
      .parse(req.body);

    const customer = await prisma.customer.findUnique({
      where: { id: customerId }
    });

    if (!customer) {
      errorResponse(res, "Customer not found", 404);
      return;
    }

    if (customer.status !== CustomerStatus.APPROVED) {
      errorResponse(res, "Voucher can only be issued to an approved customer", 400);
      return;
    }

    const voucher = await prisma.voucher.findUnique({
      where: { id: voucherId }
    });

    if (!voucher) {
      errorResponse(res, "Voucher not found", 404);
      return;
    }

    if (voucher.status !== "ACTIVE") {
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

    const existing = await prisma.customerVoucher.findUnique({
      where: {
        customerId_voucherId: {
          customerId,
          voucherId: voucher.id
        }
      }
    });

    if (existing) {
      errorResponse(res, "This voucher has already been issued to the customer", 409);
      return;
    }

    const customerVoucher = await prisma.customerVoucher.create({
      data: {
        customerId,
        voucherId: voucher.id,
        status: "ACTIVE",
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
    });

    await logAudit({
      employeeId: req.user.id,
      action: "VOUCHER_ISSUED",
      entityType: "CustomerVoucher",
      entityId: String(customerVoucher.id),
      details: {
        voucherId: voucher.id,
        customerId,
        voucherCode: voucher.code
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });

    const formatted = formatCustomerVoucherItem(customerVoucher);

    successResponse(
      res,
      formatted,
      "Voucher issued successfully",
      201
    );
  } catch (error) {
    next(error);
  }
}

/**
 * POST /:id/vouchers
 *
 * Employee issues a voucher to a customer directly from the customer profile.
 */
router.post(
  "/:id/vouchers",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_MANAGE),
  handleIssueVoucherToCustomer
);

/**
 * POST /:id/issue-voucher
 *
 * Alias for issuing voucher to customer.
 */
router.post(
  "/:id/issue-voucher",
  authenticateEmployee,
  authorizePermission(Permission.VOUCHER_MANAGE),
  handleIssueVoucherToCustomer
);

export default router;