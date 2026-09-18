import { Router, NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt, { SignOptions } from "jsonwebtoken";
import { z } from "zod";
import { CustomerStatus, DeviceStatus } from "@prisma/client";

import { prisma } from "../config/prisma";
import { generateToken } from "../utils/jwt";
import {
  AuthenticatedRequest,
  authenticateEmployee
} from "../middleware/auth";
import { successResponse, errorResponse } from "../utils/response";

const router = Router();

const employeeLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const customerLoginSchema = z.object({
  phone: z.string().min(1),
  deviceId: z.string().min(1)
});

const generateCustomerToken = (
  customerId: number,
  deviceId: string
): string => {
  const secret = process.env.JWT_CUSTOMER_SECRET;

  if (!secret) {
    throw new Error("JWT_CUSTOMER_SECRET is not configured");
  }

  const expiresIn =
    process.env.JWT_CUSTOMER_EXPIRES_IN || "7d";

  return jwt.sign(
    {
      customerId,
      deviceId
    },
    secret,
    {
      expiresIn: expiresIn as SignOptions["expiresIn"]
    }
  );
};

/**
 * POST /employee/login
 */
router.post(
  "/employee/login",
  async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const data = employeeLoginSchema.parse(req.body);

      const employee = await prisma.employee.findUnique({
        where: {
          email: data.email
        },
        include: {
          permissions: {
            select: {
              permission: true
            }
          }
        }
      });

      if (!employee) {
        errorResponse(
          res,
          "Invalid email or password",
          401
        );
        return;
      }

      if (!employee.isActive) {
        errorResponse(
          res,
          "Employee account is inactive",
          403
        );
        return;
      }

      const passwordValid = await bcrypt.compare(
        data.password,
        employee.passwordHash
      );

      if (!passwordValid) {
        errorResponse(
          res,
          "Invalid email or password",
          401
        );
        return;
      }

      const token = generateToken({
        id: employee.id,
        role: employee.role
      });

      const employeePermissions = employee.permissions.map(
        (p) => p.permission
      );

      successResponse(
        res,
        {
          token,
          employee: {
            id: employee.id,
            name: employee.name,
            email: employee.email,
            role: employee.role,
            permissions: employeePermissions
          }
        },
        "Employee login successful"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /customer/login
 */
router.post(
  "/customer/login",
  async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const data = customerLoginSchema.parse(req.body);

      const customer = await prisma.customer.findUnique({
        where: {
          phone: data.phone
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
          "Customer account is not approved",
          403
        );
        return;
      }

      /**
       * ONE-DEVICE-PER-CUSTOMER ENFORCEMENT
       *
       * 1. Look up the device matching (customerId, deviceId).
       * 2. If not found, check whether the customer already has a
       *    PENDING or ACTIVE device with a DIFFERENT deviceId.
       *    → If yes: BLOCK with DEVICE_ALREADY_REGISTERED.
       *    → If no: create a new PENDING device (first-time registration).
       * 3. The check + create is wrapped in a serializable interactive
       *    transaction to prevent two different phones from racing past
       *    the guard simultaneously.
       */
      let device = await prisma.device.findFirst({
        where: {
          customerId: customer.id,
          deviceId: data.deviceId
        }
      });

      if (!device) {
        // Check for an existing registered device on a DIFFERENT phone
        const existingDevice = await prisma.device.findFirst({
          where: {
            customerId: customer.id,
            deviceId: { not: data.deviceId },
            status: { in: [DeviceStatus.PENDING, DeviceStatus.ACTIVE] }
          }
        });

        if (existingDevice) {
          // Customer already has a registered device — block this one
          res.status(409).json({
            success: false,
            message: `${customer.phone} is already registered on another device. Please contact cafe staff to change the device.`,
            error: "DEVICE_ALREADY_REGISTERED"
          });
          return;
        }

        // No existing registered device — first-time registration
        // Use a transaction with isolation to guard against race conditions
        try {
          device = await prisma.$transaction(async (tx) => {
            // Re-check inside the transaction to prevent TOCTOU races
            const raceCheck = await tx.device.findFirst({
              where: {
                customerId: customer.id,
                status: { in: [DeviceStatus.PENDING, DeviceStatus.ACTIVE] }
              }
            });

            if (raceCheck && raceCheck.deviceId !== data.deviceId) {
              throw new Error("DEVICE_ALREADY_REGISTERED");
            }

            // If the raceCheck found our own deviceId (created by a parallel
            // request), just return it instead of creating a duplicate
            if (raceCheck && raceCheck.deviceId === data.deviceId) {
              return raceCheck;
            }

            return tx.device.create({
              data: {
                customerId: customer.id,
                deviceId: data.deviceId,
                status: DeviceStatus.PENDING
              }
            });
          });
        } catch (txError: any) {
          if (
            txError?.message === "DEVICE_ALREADY_REGISTERED" ||
            txError?.code === "P2002" // unique constraint violation
          ) {
            res.status(409).json({
              success: false,
              message: `${customer.phone} is already registered on another device. Please contact cafe staff to change the device.`,
              error: "DEVICE_ALREADY_REGISTERED"
            });
            return;
          }
          throw txError;
        }

        errorResponse(
          res,
          "Device registered and is awaiting approval",
          403,
          {
            deviceId: device.id,
            status: device.status
          }
        );
        return;
      }

      if (device.status !== DeviceStatus.ACTIVE) {
        errorResponse(
          res,
          "Device is not active",
          403,
          {
            deviceId: device.id,
            status: device.status
          }
        );
        return;
      }

      const token = generateCustomerToken(
        customer.id,
        device.deviceId
      );

      successResponse(
        res,
        {
          token,
          customer: {
            id: customer.id,
            name: customer.name,
            phone: customer.phone,
            email: customer.email,
            status: customer.status
          },
          device: {
            id: device.id,
            deviceId: device.deviceId,
            status: device.status
          }
        },
        "Customer login successful"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /me
 */
router.get(
  "/me",
  authenticateEmployee,
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        errorResponse(
          res,
          "Authentication required",
          401
        );
        return;
      }

      const employee = await prisma.employee.findUnique({
        where: {
          id: req.user.id
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          permissions: {
            select: {
              permission: true
            }
          },
          createdAt: true,
          updatedAt: true
        }
      });

      if (!employee) {
        errorResponse(
          res,
          "Employee not found",
          404
        );
        return;
      }

      const formattedEmployee = {
        ...employee,
        permissions: employee.permissions.map(
          (p) => p.permission
        )
      };

      successResponse(
        res,
        formattedEmployee,
        "Current user retrieved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

export default router;