import {
  Response,
  NextFunction,
} from "express";

import {
  Role,
  Permission,
} from "@prisma/client";

import {
  AuthenticatedRequest,
} from "./auth";

import {
  errorResponse,
} from "../utils/response";

/**
 * Checks whether the authenticated employee
 * has at least one of the required permissions.
 *
 * IMPORTANT: ADMIN users always have full access
 * and bypass individual permission checks.
 */
export const authorizePermission = (
  ...permissions: Permission[]
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
     */
    if (req.user.role === Role.ADMIN) {
      console.log(
        `[AUTHZ] ADMIN bypass granted for employee ${req.user.id}`
      );
      next();
      return;
    }

    const hasPermission =
      permissions.some(
        permission =>
          req.user!.permissions.includes(
            permission
          )
      );

    if (!hasPermission) {
      console.log(
        `[AUTHZ] Access denied for employee ${req.user.id}`,
        {
          required: permissions,
          hasPermissions: req.user.permissions,
        }
      );

      errorResponse(
        res,
        "You do not have permission to access this feature",
        403
      );
      return;
    }

    console.log(
      `[AUTHZ] Permission check passed for employee ${req.user.id}`,
      {
        required: permissions,
      }
    );

    next();
  };
};