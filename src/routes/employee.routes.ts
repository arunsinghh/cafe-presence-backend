import {
  Router,
  NextFunction,
  Response,
} from "express";

import bcrypt from "bcryptjs";

import {
  Role,
  Permission,
} from "@prisma/client";

import { z } from "zod";

import { prisma } from "../config/prisma";

import {
  AuthenticatedRequest,
  authenticateEmployee,
  authorizeRole,
} from "../middleware/auth";

import { authorizePermission } from "../middleware/permission";

import { logAudit } from "../utils/audit";

import {
  errorResponse,
  successResponse,
} from "../utils/response";

const router = Router();

/* =========================================================
   VALIDATION SCHEMAS
   ========================================================= */

const createEmployeeSchema = z.object({
  name: z.string().trim().min(2).max(100),

  email: z.string().trim().email(),

  password: z.string().min(8).max(100),

  role: z.nativeEnum(Role),
});

const updateEmployeeSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),

  email: z.string().trim().email().optional(),

  password: z.string().min(8).max(100).optional(),

  role: z.nativeEnum(Role).optional(),

  isActive: z.boolean().optional(),
});

/**
 * Used only by ADMIN to control
 * feature-level employee access.
 */
const updateEmployeePermissionsSchema = z.object({
  permissions: z.array(
    z.nativeEnum(Permission)
  ),
});

const employeeIdSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const employeeListQuerySchema = z.object({
  role: z.nativeEnum(Role).optional(),

  isActive: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),

  search: z
    .string()
    .trim()
    .max(100)
    .optional(),

  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .default(50),

  offset: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0),
});

const auditLogQuerySchema = z.object({
  employeeId: z.coerce
    .number()
    .int()
    .positive()
    .optional(),

  action: z
    .string()
    .trim()
    .max(100)
    .optional(),

  entityType: z
    .string()
    .trim()
    .max(100)
    .optional(),

  startDate: z
    .string()
    .datetime()
    .optional(),

  endDate: z
    .string()
    .datetime()
    .optional(),

  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .default(50),

  offset: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0),
});

/* =========================================================
   AUTHENTICATION
   ========================================================= */

router.use(authenticateEmployee);

/* =========================================================
   GET /
   LIST EMPLOYEES
   ========================================================= */

router.get(
  "/",

  authorizePermission(
    Permission.EMPLOYEE_VIEW,
    Permission.EMPLOYEE_MANAGE
  ),

  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const {
        role,
        isActive,
        search,
        limit,
        offset,
      } = employeeListQuerySchema.parse(
        req.query
      );

      const where = {
        ...(role !== undefined
          ? { role }
          : {}),

        ...(isActive !== undefined
          ? { isActive }
          : {}),

        ...(search
          ? {
              OR: [
                {
                  name: {
                    contains: search,
                    mode: "insensitive" as const,
                  },
                },
                {
                  email: {
                    contains: search,
                    mode: "insensitive" as const,
                  },
                },
              ],
            }
          : {}),
      };

      const [employees, total] =
        await prisma.$transaction([
          prisma.employee.findMany({
            where,

            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              isActive: true,

              permissions: {
                select: {
                  permission: true,
                },
              },

              createdAt: true,
              updatedAt: true,
            },

            orderBy: {
              createdAt: "desc",
            },

            skip: offset,

            take: limit,
          }),

          prisma.employee.count({
            where,
          }),
        ]);

      const formattedEmployees =
        employees.map((employee) => ({
          ...employee,

          permissions:
            employee.permissions.map(
              (item) => item.permission
            ),
        }));

      successResponse(
        res,
        {
          employees: formattedEmployees,

          pagination: {
            total,
            limit,
            offset,

            hasMore:
              offset + employees.length < total,
          },
        },

        "Employees retrieved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   GET /audit-logs
   LIST AUDIT LOGS

   IMPORTANT:
   This route MUST remain before GET /:id.
   ========================================================= */

router.get(
  "/audit-logs",

  authorizePermission(
    Permission.AUDIT_LOG_VIEW
  ),

  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const {
        employeeId,
        action,
        entityType,
        startDate,
        endDate,
        limit,
        offset,
      } = auditLogQuerySchema.parse(
        req.query
      );

      if (
        startDate &&
        endDate &&
        new Date(startDate) >
          new Date(endDate)
      ) {
        errorResponse(
          res,
          "startDate must be before endDate",
          400
        );

        return;
      }

      const where = {
        ...(employeeId !== undefined
          ? {
              employeeId,
            }
          : {}),

        ...(action
          ? {
              action: {
                contains: action,
                mode: "insensitive" as const,
              },
            }
          : {}),

        ...(entityType
          ? {
              entityType: {
                contains: entityType,
                mode: "insensitive" as const,
              },
            }
          : {}),

        ...(startDate || endDate
          ? {
              createdAt: {
                ...(startDate
                  ? {
                      gte: new Date(startDate),
                    }
                  : {}),

                ...(endDate
                  ? {
                      lte: new Date(endDate),
                    }
                  : {}),
              },
            }
          : {}),
      };

      const [logs, total] =
        await prisma.$transaction([
          prisma.auditLog.findMany({
            where,

            include: {
              employee: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  role: true,
                },
              },
            },

            orderBy: {
              createdAt: "desc",
            },

            skip: offset,

            take: limit,
          }),

          prisma.auditLog.count({
            where,
          }),
        ]);

      successResponse(
        res,
        {
          logs,

          pagination: {
            total,
            limit,
            offset,

            hasMore:
              offset + logs.length < total,
          },
        },

        "Audit logs retrieved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   PATCH /:id/permissions
   UPDATE EMPLOYEE FEATURE PERMISSIONS

   ADMIN ONLY

   IMPORTANT:
   This route MUST appear before PATCH /:id.
   ========================================================= */

router.patch(
  "/:id/permissions",

  authorizeRole(Role.ADMIN),

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
        employeeIdSchema.parse(
          req.params
        );

      const { permissions } =
        updateEmployeePermissionsSchema.parse(
          req.body
        );

      const employee =
        await prisma.employee.findUnique({
          where: {
            id,
          },

          select: {
            id: true,
            name: true,
            email: true,
            role: true,

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
          404
        );

        return;
      }

      /**
       * ADMIN automatically has complete
       * system access through permission middleware.
       */
      if (employee.role === Role.ADMIN) {
        errorResponse(
          res,
          "Permissions cannot be modified for an ADMIN employee",
          400
        );

        return;
      }

      /**
       * Remove duplicate permissions.
       */
      const uniquePermissions =
        [...new Set(permissions)];

      const previousPermissions =
        employee.permissions.map(
          (item) => item.permission
        );

      const updatedEmployee =
        await prisma.employee.update({
          where: {
            id,
          },

          data: {
            permissions: {
              deleteMany: {},

              create:
                uniquePermissions.map(
                  (permission) => ({
                    permission,
                  })
                ),
            },
          },

          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            isActive: true,

            permissions: {
              select: {
                permission: true,
              },
            },

            createdAt: true,
            updatedAt: true,
          },
        });

      const formattedUpdatedEmployee = {
        ...updatedEmployee,

        permissions:
          updatedEmployee.permissions.map(
            (item) => item.permission
          ),
      };

      await logAudit({
        employeeId: req.user.id,

        action:
          "EMPLOYEE_PERMISSIONS_UPDATED",

        entityType: "Employee",

        entityId: String(employee.id),

        details: {
          employeeName:
            employee.name,

          previousPermissions,

          newPermissions:
            formattedUpdatedEmployee.permissions,
        },

        ipAddress: req.ip,

        userAgent:
          req.get("user-agent"),
      });

      successResponse(
        res,
        formattedUpdatedEmployee,
        "Employee permissions updated successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   GET /:id
   GET SINGLE EMPLOYEE
   ========================================================= */

router.get(
  "/:id",

  authorizePermission(
    Permission.EMPLOYEE_VIEW,
    Permission.EMPLOYEE_MANAGE
  ),

  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { id } =
        employeeIdSchema.parse(
          req.params
        );

      const employee =
        await prisma.employee.findUnique({
          where: {
            id,
          },

          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            isActive: true,

            permissions: {
              select: {
                permission: true,
              },
            },

            createdAt: true,
            updatedAt: true,
          },
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

        permissions:
          employee.permissions.map(
            (item) => item.permission
          ),
      };

      successResponse(
        res,
        formattedEmployee,
        "Employee retrieved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   POST /
   CREATE EMPLOYEE
   ========================================================= */

router.post(
  "/",

  authorizePermission(
    Permission.EMPLOYEE_MANAGE
  ),

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

      const data =
        createEmployeeSchema.parse(
          req.body
        );

      /**
       * ADMIN can create any role.
       *
       * MANAGER can only create
       * CASHIER or VERIFIER.
       */
      if (
        req.user.role ===
          Role.MANAGER &&
        data.role !==
          Role.CASHIER &&
        data.role !==
          Role.VERIFIER
      ) {
        errorResponse(
          res,
          "Managers can only create CASHIER or VERIFIER employees",
          403
        );

        return;
      }

      const existingEmployee =
        await prisma.employee.findUnique({
          where: {
            email: data.email,
          },
        });

      if (existingEmployee) {
        errorResponse(
          res,
          "An employee with this email already exists",
          409
        );

        return;
      }

      const saltRounds = Number(
        process.env.BCRYPT_SALT_ROUNDS ||
          12
      );

      const passwordHash =
        await bcrypt.hash(
          data.password,
          saltRounds
        );

      const employee =
        await prisma.employee.create({
          data: {
            name: data.name,
            email: data.email,
            passwordHash,
            role: data.role,
            isActive: true,

            /**
             * EmployeePermission is a relation.
             * New employees start with no
             * feature permissions.
             */
            permissions: {
              create: [],
            },
          },

          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            isActive: true,

            permissions: {
              select: {
                permission: true,
              },
            },

            createdAt: true,
            updatedAt: true,
          },
        });

      const formattedEmployee = {
        ...employee,

        permissions:
          employee.permissions.map(
            (item) => item.permission
          ),
      };

      await logAudit({
        employeeId:
          req.user.id,

        action:
          "EMPLOYEE_CREATED",

        entityType:
          "Employee",

        entityId:
          String(employee.id),

        details: {
          name: employee.name,
          email: employee.email,
          role: employee.role,
        },

        ipAddress: req.ip,

        userAgent:
          req.get("user-agent"),
      });

      successResponse(
        res,
        formattedEmployee,
        "Employee created successfully",
        201
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   PATCH /:id
   UPDATE EMPLOYEE
   ========================================================= */

router.patch(
  "/:id",

  authorizePermission(
    Permission.EMPLOYEE_MANAGE
  ),

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
        employeeIdSchema.parse(
          req.params
        );

      const data =
        updateEmployeeSchema.parse(
          req.body
        );

      const employee =
        await prisma.employee.findUnique({
          where: {
            id,
          },
        });

      if (!employee) {
        errorResponse(
          res,
          "Employee not found",
          404
        );

        return;
      }

      /**
       * Prevent employee from
       * deactivating themselves.
       */
      if (
        req.user.id ===
          employee.id &&
        data.isActive === false
      ) {
        errorResponse(
          res,
          "You cannot deactivate your own account",
          400
        );

        return;
      }

      /**
       * Prevent employee from
       * changing their own role.
       */
      if (
        req.user.id ===
          employee.id &&
        data.role !== undefined &&
        data.role !== employee.role
      ) {
        errorResponse(
          res,
          "You cannot change your own role",
          400
        );

        return;
      }

      /**
       * MANAGER can only assign
       * CASHIER or VERIFIER.
       */
      if (
        req.user.role ===
          Role.MANAGER &&
        data.role !== undefined &&
        data.role !==
          Role.CASHIER &&
        data.role !==
          Role.VERIFIER
      ) {
        errorResponse(
          res,
          "Managers can only assign CASHIER or VERIFIER roles",
          403
        );

        return;
      }

      /**
       * MANAGER cannot modify
       * an ADMIN.
       */
      if (
        req.user.role ===
          Role.MANAGER &&
        employee.role ===
          Role.ADMIN
      ) {
        errorResponse(
          res,
          "Managers cannot modify an ADMIN employee",
          403
        );

        return;
      }

      /**
       * Check email uniqueness.
       */
      if (
        data.email !== undefined &&
        data.email !== employee.email
      ) {
        const existingEmployee =
          await prisma.employee.findUnique({
            where: {
              email: data.email,
            },
          });

        if (
          existingEmployee &&
          existingEmployee.id !==
            employee.id
        ) {
          errorResponse(
            res,
            "An employee with this email already exists",
            409
          );

          return;
        }
      }

      const updateData: {
        name?: string;
        email?: string;
        passwordHash?: string;
        role?: Role;
        isActive?: boolean;
      } = {};

      if (
        data.name !== undefined
      ) {
        updateData.name =
          data.name;
      }

      if (
        data.email !== undefined
      ) {
        updateData.email =
          data.email;
      }

      if (
        data.role !== undefined
      ) {
        updateData.role =
          data.role;
      }

      if (
        data.isActive !== undefined
      ) {
        updateData.isActive =
          data.isActive;
      }

      if (
        data.password !== undefined
      ) {
        const saltRounds =
          Number(
            process.env
              .BCRYPT_SALT_ROUNDS ||
              12
          );

        updateData.passwordHash =
          await bcrypt.hash(
            data.password,
            saltRounds
          );
      }

      const updatedEmployee =
        await prisma.employee.update({
          where: {
            id: employee.id,
          },

          data: updateData,

          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            isActive: true,

            permissions: {
              select: {
                permission: true,
              },
            },

            createdAt: true,
            updatedAt: true,
          },
        });

      const formattedUpdatedEmployee = {
        ...updatedEmployee,

        permissions:
          updatedEmployee.permissions.map(
            (item) => item.permission
          ),
      };

      await logAudit({
        employeeId:
          req.user.id,

        action:
          "EMPLOYEE_UPDATED",

        entityType:
          "Employee",

        entityId:
          String(employee.id),

        details: {
          changedFields:
            Object.keys(data),

          previousRole:
            employee.role,

          newRole:
            updatedEmployee.role,

          previousIsActive:
            employee.isActive,

          newIsActive:
            updatedEmployee.isActive,
        },

        ipAddress: req.ip,

        userAgent:
          req.get("user-agent"),
      });

      successResponse(
        res,
        formattedUpdatedEmployee,
        "Employee updated successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   POST /:id/deactivate
   DEACTIVATE EMPLOYEE
   ========================================================= */

router.post(
  "/:id/deactivate",

  authorizePermission(
    Permission.EMPLOYEE_MANAGE
  ),

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
        employeeIdSchema.parse(
          req.params
        );

      if (
        req.user.id === id
      ) {
        errorResponse(
          res,
          "You cannot deactivate your own account",
          400
        );

        return;
      }

      const employee =
        await prisma.employee.findUnique({
          where: {
            id,
          },
        });

      if (!employee) {
        errorResponse(
          res,
          "Employee not found",
          404
        );

        return;
      }

      if (
        req.user.role ===
          Role.MANAGER &&
        employee.role ===
          Role.ADMIN
      ) {
        errorResponse(
          res,
          "Managers cannot deactivate an ADMIN employee",
          403
        );

        return;
      }

      if (!employee.isActive) {
        errorResponse(
          res,
          "Employee is already inactive",
          400
        );

        return;
      }

      const updatedEmployee =
        await prisma.employee.update({
          where: {
            id: employee.id,
          },

          data: {
            isActive: false,
          },

          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            isActive: true,

            permissions: {
              select: {
                permission: true,
              },
            },

            createdAt: true,
            updatedAt: true,
          },
        });

      const formattedUpdatedEmployee = {
        ...updatedEmployee,

        permissions:
          updatedEmployee.permissions.map(
            (item) => item.permission
          ),
      };

      await logAudit({
        employeeId:
          req.user.id,

        action:
          "EMPLOYEE_DEACTIVATED",

        entityType:
          "Employee",

        entityId:
          String(employee.id),

        details: {
          employeeName:
            employee.name,

          employeeEmail:
            employee.email,

          role:
            employee.role,
        },

        ipAddress:
          req.ip,

        userAgent:
          req.get("user-agent"),
      });

      successResponse(
        res,
        formattedUpdatedEmployee,
        "Employee deactivated successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   POST /:id/activate
   ACTIVATE EMPLOYEE
   ========================================================= */

router.post(
  "/:id/activate",

  authorizePermission(
    Permission.EMPLOYEE_MANAGE
  ),

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
        employeeIdSchema.parse(
          req.params
        );

      const employee =
        await prisma.employee.findUnique({
          where: {
            id,
          },
        });

      if (!employee) {
        errorResponse(
          res,
          "Employee not found",
          404
        );

        return;
      }

      if (
        req.user.role ===
          Role.MANAGER &&
        employee.role ===
          Role.ADMIN
      ) {
        errorResponse(
          res,
          "Managers cannot activate an ADMIN employee",
          403
        );

        return;
      }

      if (employee.isActive) {
        errorResponse(
          res,
          "Employee is already active",
          400
        );

        return;
      }

      const updatedEmployee =
        await prisma.employee.update({
          where: {
            id: employee.id,
          },

          data: {
            isActive: true,
          },

          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            isActive: true,

            permissions: {
              select: {
                permission: true,
              },
            },

            createdAt: true,
            updatedAt: true,
          },
        });

      const formattedUpdatedEmployee = {
        ...updatedEmployee,

        permissions:
          updatedEmployee.permissions.map(
            (item) => item.permission
          ),
      };

      await logAudit({
        employeeId:
          req.user.id,

        action:
          "EMPLOYEE_ACTIVATED",

        entityType:
          "Employee",

        entityId:
          String(employee.id),

        details: {
          employeeName:
            employee.name,

          employeeEmail:
            employee.email,

          role:
            employee.role,
        },

        ipAddress:
          req.ip,

        userAgent:
          req.get("user-agent"),
      });

      successResponse(
        res,
        formattedUpdatedEmployee,
        "Employee activated successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

export default router;