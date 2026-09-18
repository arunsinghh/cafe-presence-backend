import { Router, NextFunction, Response } from "express";
import { DeviceStatus, Permission, Role } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../config/prisma";
import {
  AuthenticatedRequest,
  authenticateEmployee
} from "../middleware/auth";
import { authorizePermission } from "../middleware/permission";
import { logAudit } from "../utils/audit";
import { successResponse, errorResponse } from "../utils/response";

const router = Router();

const deviceIdParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

const approveDeviceSchema = z.object({
  deviceId: z.coerce.number().int().positive()
});

const updateDeviceStatusSchema = z.object({
  status: z.enum([
    DeviceStatus.ACTIVE,
    DeviceStatus.REVOKED,
    DeviceStatus.LOST
  ])
});

router.use(authenticateEmployee);

/**
 * GET /devices
 * Get devices with optional status filter and customer search.
 *
 * Query params:
 *   status  - PENDING | ACTIVE | REVOKED | LOST
 *   search  - searches customer name, phone, or device installation ID
 *   limit   - pagination limit (default 50, max 100)
 *   offset  - pagination offset (default 0)
 */
const deviceListQuerySchema = z.object({
  status: z
    .enum([
      DeviceStatus.PENDING,
      DeviceStatus.ACTIVE,
      DeviceStatus.REVOKED,
      DeviceStatus.LOST
    ])
    .optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0)
});

router.get(
  "/",
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
      const { status, search, limit, offset } =
        deviceListQuerySchema.parse(req.query);

      const where: any = {
        ...(status !== undefined ? { status } : {}),
        ...(search
          ? {
              OR: [
                {
                  deviceId: {
                    contains: search,
                    mode: "insensitive"
                  }
                },
                {
                  customer: {
                    name: {
                      contains: search,
                      mode: "insensitive"
                    }
                  }
                },
                {
                  customer: {
                    phone: {
                      contains: search,
                      mode: "insensitive"
                    }
                  }
                }
              ]
            }
          : {})
      };

      const [devices, total] = await prisma.$transaction([
        prisma.device.findMany({
          where,
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                phone: true,
                email: true,
                status: true
              }
            }
          },
          orderBy: {
            createdAt: "desc"
          },
          skip: offset,
          take: limit
        }),
        prisma.device.count({ where })
      ]);

      successResponse(
        res,
        {
          devices,
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + devices.length < total
          }
        },
        "Devices retrieved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /devices/pending
 * Get all devices awaiting approval.
 */
router.get(
  "/pending",
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
      const devices = await prisma.device.findMany({
        where: {
          status: DeviceStatus.PENDING
        },
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
              status: true
            }
          }
        },
        orderBy: {
          createdAt: "asc"
        }
      });

      successResponse(
        res,
        devices,
        "Pending devices retrieved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /devices/customer/:id
 * Get all devices belonging to a customer.
 */
router.get(
  "/customer/:id",
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
      const { id: customerId } =
        deviceIdParamSchema.parse(req.params);

      const customer = await prisma.customer.findUnique({
        where: {
          id: customerId
        }
      });

      if (!customer) {
        errorResponse(res, "Customer not found", 404);
        return;
      }

      const devices = await prisma.device.findMany({
        where: {
          customerId
        },
        orderBy: {
          createdAt: "desc"
        }
      });

      successResponse(
        res,
        devices,
        "Customer devices retrieved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /devices/:id/approve
 *
 * Approving a device:
 * 1. Revokes every other ACTIVE device for the customer.
 * 2. Activates the requested device.
 *
 * Both operations happen in ONE database transaction.
 */
router.post(
  "/:id/approve",
  authorizePermission(Permission.CUSTOMER_MANAGE),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {

      const { id: deviceId } =
        deviceIdParamSchema.parse(req.params);

      const device = await prisma.device.findUnique({
        where: {
          id: deviceId
        },
        include: {
          customer: true
        }
      });

      if (!device) {
        errorResponse(res, "Device not found", 404);
        return;
      }

      if (device.status === DeviceStatus.ACTIVE) {
        errorResponse(res, "Device is already active", 400);
        return;
      }

      const result = await prisma.$transaction(async (tx) => {
        await tx.device.updateMany({
          where: {
            customerId: device.customerId,
            status: DeviceStatus.ACTIVE,
            id: {
              not: device.id
            }
          },
          data: {
            status: DeviceStatus.REVOKED,
            revokedAt: new Date()
          }
        });

        return tx.device.update({
          where: {
            id: device.id
          },
          data: {
            status: DeviceStatus.ACTIVE,
            approvedAt: new Date(),
            revokedAt: null,
            lostAt: null
          }
        });
      });

      await logAudit({
        employeeId: req.user!.id,
        action: "DEVICE_APPROVED",
        entityType: "Device",
        entityId: String(result.id),
        details: {
          customerId: result.customerId,
          deviceId: result.deviceId
        }
      });

      successResponse(
        res,
        result,
        "Device approved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /devices/:id/status
 * Change a device status.
 */
router.patch(
  "/:id/status",
  authorizePermission(Permission.CUSTOMER_MANAGE),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {

      const { id: deviceId } =
        deviceIdParamSchema.parse(req.params);

      const { status } =
        updateDeviceStatusSchema.parse(req.body);

      const device = await prisma.device.findUnique({
        where: {
          id: deviceId
        }
      });

      if (!device) {
        errorResponse(res, "Device not found", 404);
        return;
      }

      const now = new Date();

      const updatedDevice = await prisma.device.update({
        where: {
          id: device.id
        },
        data: {
          status,
          ...(status === DeviceStatus.REVOKED
            ? {
                revokedAt: now,
                lostAt: null
              }
            : {}),
          ...(status === DeviceStatus.LOST
            ? {
                lostAt: now,
                revokedAt: null
              }
            : {}),
          ...(status === DeviceStatus.ACTIVE
            ? {
                approvedAt: device.approvedAt ?? now,
                revokedAt: null,
                lostAt: null
              }
            : {})
        }
      });

      await logAudit({
        employeeId: req.user!.id,
        action: "DEVICE_STATUS_UPDATED",
        entityType: "Device",
        entityId: String(device.id),
        details: {
          customerId: device.customerId,
          deviceId: device.deviceId,
          previousStatus: device.status,
          newStatus: status
        }
      });

      successResponse(
        res,
        updatedDevice,
        "Device status updated successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /devices/:id/revoke
 * Revoke a specific device.
 */
router.post(
  "/:id/revoke",
  authorizePermission(Permission.CUSTOMER_MANAGE),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { id: deviceId } =
        deviceIdParamSchema.parse(req.params);

      const device = await prisma.device.findUnique({
        where: {
          id: deviceId
        }
      });

      if (!device) {
        errorResponse(res, "Device not found", 404);
        return;
      }

      const updatedDevice = await prisma.device.update({
        where: {
          id: device.id
        },
        data: {
          status: DeviceStatus.REVOKED,
          revokedAt: new Date(),
          lostAt: null
        }
      });

      await logAudit({
        employeeId: req.user!.id,
        action: "DEVICE_REVOKED",
        entityType: "Device",
        entityId: String(device.id),
        details: {
          customerId: device.customerId,
          deviceId: device.deviceId
        }
      });

      successResponse(
        res,
        updatedDevice,
        "Device revoked successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /devices/:id/lost
 * Mark a device as lost.
 */
router.post(
  "/:id/lost",
  authorizePermission(Permission.CUSTOMER_MANAGE),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { id: deviceId } =
        deviceIdParamSchema.parse(req.params);

      const device = await prisma.device.findUnique({
        where: {
          id: deviceId
        }
      });

      if (!device) {
        errorResponse(res, "Device not found", 404);
        return;
      }

      const updatedDevice = await prisma.device.update({
        where: {
          id: device.id
        },
        data: {
          status: DeviceStatus.LOST,
          lostAt: new Date(),
          revokedAt: null
        }
      });

      await logAudit({
        employeeId: req.user!.id,
        action: "DEVICE_MARKED_LOST",
        entityType: "Device",
        entityId: String(device.id),
        details: {
          customerId: device.customerId,
          deviceId: device.deviceId
        }
      });

      successResponse(
        res,
        updatedDevice,
        "Device marked as lost successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /devices/approve
 *
 * Alternative approval endpoint using deviceId in the body.
 */
router.post(
  "/approve",
  authorizePermission(Permission.CUSTOMER_MANAGE),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { deviceId } =
        approveDeviceSchema.parse(req.body);

      const device = await prisma.device.findUnique({
        where: {
          id: deviceId
        }
      });

      if (!device) {
        errorResponse(res, "Device not found", 404);
        return;
      }

      const result = await prisma.$transaction(async (tx) => {
        await tx.device.updateMany({
          where: {
            customerId: device.customerId,
            status: DeviceStatus.ACTIVE,
            id: {
              not: device.id
            }
          },
          data: {
            status: DeviceStatus.REVOKED,
            revokedAt: new Date()
          }
        });

        return tx.device.update({
          where: {
            id: device.id
          },
          data: {
            status: DeviceStatus.ACTIVE,
            approvedAt: new Date(),
            revokedAt: null,
            lostAt: null
          }
        });
      });

      await logAudit({
        employeeId: req.user!.id,
        action: "DEVICE_APPROVED",
        entityType: "Device",
        entityId: String(result.id),
        details: {
          customerId: result.customerId,
          deviceId: result.deviceId
        }
      });

      successResponse(
        res,
        result,
        "Device approved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /devices/:id/replace
 *
 * Authorized staff replaces the customer's currently registered device.
 *
 * This atomically revokes the specified device (and any other PENDING
 * devices for the same customer), allowing the customer to register a
 * new device through the normal first-time registration/approval flow.
 *
 * The new device is NOT created here — the customer's next login from
 * the new phone will create a PENDING device, which then goes through
 * the existing admin approval workflow.
 */
router.post(
  "/:id/replace",
  authorizePermission(Permission.CUSTOMER_MANAGE),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { id: deviceId } =
        deviceIdParamSchema.parse(req.params);

      const device = await prisma.device.findUnique({
        where: {
          id: deviceId
        },
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              phone: true
            }
          }
        }
      });

      if (!device) {
        errorResponse(res, "Device not found", 404);
        return;
      }

      if (
        device.status !== DeviceStatus.ACTIVE &&
        device.status !== DeviceStatus.PENDING
      ) {
        errorResponse(
          res,
          "Device is already revoked or marked as lost",
          400
        );
        return;
      }

      const now = new Date();

      // Atomically revoke this device and any other PENDING devices
      // for the same customer to ensure a clean slate
      await prisma.$transaction(async (tx) => {
        // Revoke the target device
        await tx.device.update({
          where: { id: device.id },
          data: {
            status: DeviceStatus.REVOKED,
            revokedAt: now
          }
        });

        // Also revoke any other PENDING devices for the same customer
        await tx.device.updateMany({
          where: {
            customerId: device.customerId,
            id: { not: device.id },
            status: DeviceStatus.PENDING
          },
          data: {
            status: DeviceStatus.REVOKED,
            revokedAt: now
          }
        });
      });

      await logAudit({
        employeeId: req.user!.id,
        action: "DEVICE_REPLACED",
        entityType: "Device",
        entityId: String(device.id),
        details: {
          customerId: device.customerId,
          customerPhone: device.customer.phone,
          customerName: device.customer.name,
          oldDeviceId: device.deviceId,
          oldDeviceStatus: device.status,
          replacedAt: now.toISOString()
        }
      });

      successResponse(
        res,
        {
          replacedDevice: {
            id: device.id,
            deviceId: device.deviceId,
            previousStatus: device.status,
            newStatus: DeviceStatus.REVOKED
          },
          customer: device.customer,
          message: "Device has been replaced. The customer can now register a new device."
        },
        "Device replaced successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

export default router;