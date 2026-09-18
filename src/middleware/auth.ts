import {
  Request,
  Response,
  NextFunction,
} from "express";

import {
  Role,
  DeviceStatus,
  CustomerStatus,
  Permission,
} from "@prisma/client";

import { prisma } from "../config/prisma";

import {
  verifyToken,
  EmployeeTokenPayload,
  CustomerTokenPayload,
} from "../utils/jwt";

import { errorResponse } from "../utils/response";

export interface AuthenticatedRequest
  extends Request {
  user?: {
    id: number;
    role: Role;
    permissions: Permission[];
  };

  device?: {
    id: number;
    deviceId: string;
    customerId: number;
    status: DeviceStatus;

    customer: {
      id: number;
      status: CustomerStatus;
    };
  };
}

/* =========================================================
   TOKEN EXTRACTION
   ========================================================= */

const extractToken = (
  req: Request
): string | null => {
  const authorization =
    req.headers.authorization;

  if (!authorization) {
    return null;
  }

  const parts =
    authorization.trim().split(/\s+/);

  if (
    parts.length !== 2 ||
    parts[0] !== "Bearer" ||
    !parts[1]
  ) {
    return null;
  }

  return parts[1];
};

/* =========================================================
   EMPLOYEE AUTHENTICATION
   ========================================================= */

export const authenticateEmployee =
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const token = extractToken(req);

      if (!token) {
        errorResponse(
          res,
          "Authentication token is required",
          401
        );

        return;
      }

      let payload: EmployeeTokenPayload;

      try {
        const decoded =
          verifyToken(token);

        if (
          !("id" in decoded) ||
          !("role" in decoded)
        ) {
          errorResponse(
            res,
            "Invalid employee token",
            401
          );

          return;
        }

        payload = decoded as EmployeeTokenPayload;
      } catch {
        errorResponse(
          res,
          "Invalid or expired token",
          401
        );

        return;
      }

      if (
        typeof payload.id !== "number" ||
        typeof payload.role !== "string"
      ) {
        errorResponse(
          res,
          "Invalid employee token",
          401
        );

        return;
      }

      const employee =
        await prisma.employee.findUnique({
          where: {
            id: payload.id,
          },

          select: {
            id: true,
            role: true,
            isActive: true,

            permissions: {
              select: {
                permission: true,
              },
            },
          },
        });

      if (!employee) {
        errorResponse(
          res,
          "Employee not found",
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

      if (
        employee.role !== payload.role
      ) {
        errorResponse(
          res,
          "Invalid employee token",
          401
        );

        return;
      }

      /**
       * EmployeePermission is a relation.
       *
       * Convert:
       *
       * [
       *   { permission: CUSTOMER_VIEW },
       *   { permission: CUSTOMER_MANAGE }
       * ]
       *
       * Into:
       *
       * [
       *   CUSTOMER_VIEW,
       *   CUSTOMER_MANAGE
       * ]
       */
      const employeePermissions: Permission[] =
        employee.permissions.map(
          (item) => item.permission
        );

      req.user = {
        id: employee.id,

        role: employee.role,

        permissions:
          employeePermissions,
      };

      /**
       * Debug logging for authentication
       * and authorization flow.
       * Remove or disable in production.
       */
      console.log(
        `[AUTH] Employee ${employee.id} (${employee.role}) authenticated`,
        {
          permissions:
            employeePermissions.length,
        }
      );

      next();
    } catch (error) {
      next(error);
    }
  };

/* =========================================================
   ROLE AUTHORIZATION
   ========================================================= */

export const authorizeRole = (
  ...roles: Role[]
) => {
  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void => {
    if (!req.user) {
      errorResponse(
        res,
        "Employee authentication required",
        401
      );

      return;
    }

    /**
     * ADMIN always has full access.
     * ADMIN is the super administrator and
     * should never be blocked by role checks.
     */
    if (req.user.role === Role.ADMIN) {
      console.log(
        `[AUTHZ] ADMIN bypass granted for employee ${req.user.id}`
      );
      next();
      return;
    }

    if (
      !roles.includes(
        req.user.role
      )
    ) {
      console.log(
        `[AUTHZ] Access denied for employee ${req.user.id} (${req.user.role})`,
        {
          required: roles,
        }
      );

      errorResponse(
        res,
        "Insufficient permissions",
        403
      );

      return;
    }

    console.log(
      `[AUTHZ] Role check passed for employee ${req.user.id} (${req.user.role})`
    );

    next();
  };
};

/* =========================================================
   CUSTOMER DEVICE AUTHENTICATION
   ========================================================= */

export const authenticateCustomerDevice =
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const token = extractToken(req);

      if (!token) {
        errorResponse(
          res,
          "Authentication token is required",
          401
        );

        return;
      }

      let payload: CustomerTokenPayload;

      try {
        const decoded =
          verifyToken(token);

        if (
          !("customerId" in decoded) ||
          !("deviceId" in decoded)
        ) {
          errorResponse(
            res,
            "Invalid customer token",
            401
          );

          return;
        }

        if (
          typeof decoded.customerId !==
            "number" ||
          typeof decoded.deviceId !==
            "string" ||
          !decoded.deviceId
        ) {
          errorResponse(
            res,
            "Invalid customer token",
            401
          );

          return;
        }

        payload =
          decoded as CustomerTokenPayload;
      } catch {
        errorResponse(
          res,
          "Invalid or expired customer token",
          401
        );

        return;
      }

      const device =
        await prisma.device.findFirst({
          where: {
            deviceId:
              payload.deviceId,

            customerId:
              payload.customerId,
          },

          include: {
            customer: {
              select: {
                id: true,
                status: true,
              },
            },
          },
        });

      if (!device) {
        errorResponse(
          res,
          "Device not found",
          401
        );

        return;
      }

      if (
        device.status !==
        DeviceStatus.ACTIVE
      ) {
        errorResponse(
          res,
          "Device is not active",
          403
        );

        return;
      }

      if (
        device.customer.status !==
        CustomerStatus.APPROVED
      ) {
        errorResponse(
          res,
          "Customer account is not active",
          403
        );

        return;
      }

      req.device = {
        id: device.id,
        deviceId:
          device.deviceId,
        customerId:
          device.customerId,
        status:
          device.status,

        customer: {
          id:
            device.customer.id,

          status:
            device.customer.status,
        },
      };

      next();
    } catch (error) {
      next(error);
    }
  };