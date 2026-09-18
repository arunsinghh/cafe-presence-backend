import {
  Router,
  Request,
  NextFunction,
  Response,
} from "express";

import { z } from "zod";

import { prisma } from "../config/prisma";

import {
  AuthenticatedRequest,
  authenticateEmployee,
  authorizeRole,
} from "../middleware/auth";

import { authorizePermission } from "../middleware/permission";

import { Role, Permission } from "@prisma/client";

import { logAudit } from "../utils/audit";

import {
  errorResponse,
  successResponse,
} from "../utils/response";

const router = Router();

/**
 * Validation schema for cafe configuration
 */
const cafeConfigSchema = z.object({
  cafeName: z.string().trim().min(1).max(255),
  latitude: z.number().min(-90).max(90),
  longitude: z
    .number()
    .min(-180)
    .max(180),
  allowedRadiusMeters: z
    .number()
    .positive(),
  qrValiditySeconds: z
    .number()
    .int()
    .positive()
    .default(60),
  qrRotationSeconds: z
    .number()
    .int()
    .positive()
    .default(30),
  loyaltyPointsPerUnit: z
    .number()
    .nonnegative()
    .default(1),
  isPresenceEnabled: z
    .boolean()
    .default(true),
});

/**
 * GET /cafe-config/public
 *
 * Public endpoint for mobile applications to fetch cafe location data.
 * Returns location information needed for GPS verification.
 * No authentication required.
 */
export async function handleGetPublicCafeConfig(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const config = await prisma.cafeConfig.findUnique({
      where: {
        id: 1,
      },
      select: {
        cafeName: true,
        latitude: true,
        longitude: true,
        allowedRadiusMeters: true,
        isPresenceEnabled: true,
      },
    });

    if (!config) {
      errorResponse(
        res,
        "Cafe configuration not found",
        500
      );
      return;
    }

    const payload = {
      cafeName: config.cafeName,
      latitude: config.latitude,
      longitude: config.longitude,
      radiusMeters: config.allowedRadiusMeters,
      allowedRadiusMeters: config.allowedRadiusMeters,
      isPresenceEnabled: config.isPresenceEnabled,
      presenceEnabled: config.isPresenceEnabled,
    };

    res.status(200).json({
      success: true,
      message: "Cafe location information retrieved successfully",
      data: payload,
      config: payload,
      cafe: payload,
    });
  } catch (error) {
    next(error);
  }
}

router.get("/public", handleGetPublicCafeConfig);

/**
 * GET /cafe-config
 *
 * Retrieve the current cafe configuration.
 * Only accessible to authenticated employees.
 */
router.get(
  "/",
  authenticateEmployee,
  authorizePermission(
    Permission.CAFE_CONFIG_VIEW,
    Permission.CAFE_CONFIG_MANAGE
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

      console.log(
        `[ROUTE] GET /cafe-config - Employee ${req.user.id} (${req.user.role})`
      );

      const config =
        await prisma.cafeConfig.findUnique({
          where: {
            id: 1,
          },
        });

      successResponse(
        res,
        config || null,
        "Cafe configuration retrieved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /cafe-config
 *
 * Create or update the cafe configuration (upsert).
 * Only ADMIN users can perform this action.
 */
router.put(
  "/",
  authenticateEmployee,
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

      console.log(
        `[ROUTE] PUT /cafe-config - Employee ${req.user.id} (${req.user.role})`
      );

      // Parse and validate request body
      let data;

      try {
        data = cafeConfigSchema.parse(
          req.body
        );
      } catch (validationError) {
        if (
          validationError instanceof z.ZodError
        ) {
          console.log(
            `[ROUTE] PUT /cafe-config - Validation error:`,
            validationError.errors[0]
          );

          errorResponse(
            res,
            validationError.errors[0]
              ?.message || "Validation failed",
            400
          );

          return;
        }

        throw validationError;
      }

      // Check if configuration already exists
      const existingConfig =
        await prisma.cafeConfig.findUnique({
          where: {
            id: 1,
          },
        });

      let config;
      let action = "create";

      if (existingConfig) {
        // Update existing configuration
        config =
          await prisma.cafeConfig.update({
            where: {
              id: 1,
            },

            data: {
              cafeName: data.cafeName,
              latitude: data.latitude,
              longitude: data.longitude,
              allowedRadiusMeters:
                data.allowedRadiusMeters,
              qrValiditySeconds:
                data.qrValiditySeconds,
              qrRotationSeconds:
                data.qrRotationSeconds,
              loyaltyPointsPerUnit:
                data.loyaltyPointsPerUnit,
              isPresenceEnabled:
                data.isPresenceEnabled,
            },
          });

        action = "update";
      } else {
        // Create new configuration
        config =
          await prisma.cafeConfig.create({
            data: {
              id: 1,
              cafeName: data.cafeName,
              latitude: data.latitude,
              longitude: data.longitude,
              allowedRadiusMeters:
                data.allowedRadiusMeters,
              qrValiditySeconds:
                data.qrValiditySeconds,
              qrRotationSeconds:
                data.qrRotationSeconds,
              loyaltyPointsPerUnit:
                data.loyaltyPointsPerUnit,
              isPresenceEnabled:
                data.isPresenceEnabled,
            },
          });
      }

      console.log(
        `[ROUTE] PUT /cafe-config - ${action}d successfully`
      );

      // Log the audit
      await logAudit({
        employeeId: req.user.id,
        action: `${action}_cafe_config`,
        entityType: "CafeConfig",
        entityId: "1",
        details: {
          cafeName: config.cafeName,
          latitude: config.latitude,
          longitude: config.longitude,
          allowedRadiusMeters:
            config.allowedRadiusMeters,
        },
      });

      successResponse(
        res,
        config,
        `Cafe configuration ${action}d successfully`,
        201
      );
    } catch (error) {
      next(error);
    }
  }
);

export default router;
