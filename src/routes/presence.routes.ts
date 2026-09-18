import { Router, NextFunction, Response } from "express";
import { z } from "zod";
import {
  PresenceMethod,
  PresenceResult,
  Permission,
  Role
} from "@prisma/client";

import { prisma } from "../config/prisma";
import {
  AuthenticatedRequest,
  authenticateEmployee,
  authenticateCustomerDevice,
  authorizeRole
} from "../middleware/auth";
import { authorizePermission } from "../middleware/permission";
import { errorResponse, successResponse } from "../utils/response";
import { calculateHaversineDistance } from "../utils/geo";
import { handleGetPublicCafeConfig } from "./cafe-config.routes";

export { calculateHaversineDistance };

const router = Router();

/**
 * GET /presence/config
 * Public cafe location configuration for mobile GPS presence verification.
 * Compatible with Android ApiService.kt: GET /presence/config
 */
router.get("/config", handleGetPublicCafeConfig);

const verifyPresenceSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  deviceId: z.union([z.string(), z.number()]).optional(),
  accuracy: z.number().nonnegative().optional(),
  insideCafe: z.boolean().optional(),
  purpose: z.string().trim().max(100).optional()
});

const logsQuerySchema = z.object({
  customerId: z.coerce.number().int().positive().optional(),
  result: z
    .enum([
      PresenceResult.SUCCESS,
      PresenceResult.FAILED,
      PresenceResult.REJECTED
    ])
    .optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0)
});

/**
 * POST /verify
 *
 * Customer verifies presence using GPS coordinates only.
 * The server authoritatively calculates the distance using the Haversine formula
 * against the cafe coordinates from CafeConfig.
 *
 * Distance <= allowedRadiusMeters (50m) -> SUCCESS / INSIDE_CAFE
 * Distance > allowedRadiusMeters (50m)  -> FAILED / OUTSIDE_CAFE
 */
router.post(
  "/verify",
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

      const data = verifyPresenceSchema.parse(req.body);

      const customerId = req.device.customerId;
      const deviceId = req.device.id;

      // Validate device ownership if deviceId provided in request
      if (
        data.deviceId !== undefined &&
        String(data.deviceId) !== req.device.deviceId &&
        String(data.deviceId) !== String(req.device.id)
      ) {
        errorResponse(
          res,
          "Device ID does not match authenticated device",
          403
        );
        return;
      }

      const cafeConfig = await prisma.cafeConfig.findUnique({
        where: {
          id: 1
        }
      });

      if (!cafeConfig) {
        errorResponse(
          res,
          "Cafe configuration not found",
          500
        );
        return;
      }

      if (!cafeConfig.isPresenceEnabled) {
        errorResponse(
          res,
          "Presence verification is currently disabled",
          503
        );
        return;
      }

      /**
       * DEBUG LOGGING: Location Verification Diagnostic
       */
      const debugLog = {
        timestamp: new Date().toISOString(),
        deviceId,
        customerId,
        customerLocation: {
          latitude: data.latitude,
          longitude: data.longitude,
          accuracy: data.accuracy !== undefined ? `${Math.round(data.accuracy)} meters` : "N/A"
        },
        cafeLocation: {
          latitude: cafeConfig.latitude,
          longitude: cafeConfig.longitude
        },
        allowedRadius: `${cafeConfig.allowedRadiusMeters} meters`
      };

      if (process.env.NODE_ENV === "development") {
        console.log(
          "📍 LOCATION VERIFICATION DEBUG",
          JSON.stringify(debugLog, null, 2)
        );
      }

      const distanceMeters =
        calculateHaversineDistance(
          data.latitude,
          data.longitude,
          cafeConfig.latitude,
          cafeConfig.longitude
        );

      if (process.env.NODE_ENV === "development") {
        console.log("📐 DISTANCE CALCULATION", {
          distance: `${Math.round(distanceMeters)} meters`,
          allowedRadius: `${cafeConfig.allowedRadiusMeters} meters`,
          isInside: distanceMeters <= cafeConfig.allowedRadiusMeters
        });
      }

      const now = new Date();

      if (
        distanceMeters >
        cafeConfig.allowedRadiusMeters
      ) {
        const rejectedLog = await prisma.presenceLog.create({
          data: {
            customerId,
            deviceId,
            method: PresenceMethod.GPS,
            latitude: data.latitude,
            longitude: data.longitude,
            accuracy: data.accuracy ?? null,
            distanceMeters,
            purpose: data.purpose || "CAFE_PRESENCE",
            result: PresenceResult.REJECTED,
            timestamp: now
          }
        });

        if (process.env.NODE_ENV === "development") {
          console.log("❌ REJECTED: Outside cafe radius", {
            distance: `${Math.round(distanceMeters)} meters`,
            allowedRadius: `${cafeConfig.allowedRadiusMeters} meters`,
            difference: `${Math.round(distanceMeters - cafeConfig.allowedRadiusMeters)} meters over limit`
          });
        }

        errorResponse(
          res,
          "You are outside the cafe presence radius",
          403,
          {
            status: "FAILED",
            decision: "OUTSIDE_CAFE",
            verified: false,
            presenceLogId: rejectedLog.id,
            distanceMeters: Math.round(distanceMeters * 100) / 100,
            allowedRadiusMeters:
              cafeConfig.allowedRadiusMeters
          }
        );
        return;
      }

      /*
       * GPS verified successfully within allowed radius.
       * Record the presence verification using PresenceMethod.GPS.
       */
      const presenceLog = await prisma.presenceLog.create({
        data: {
          customerId,
          deviceId,
          method: PresenceMethod.GPS,
          latitude: data.latitude,
          longitude: data.longitude,
          accuracy: data.accuracy ?? null,
          distanceMeters,
          purpose: data.purpose || "CAFE_PRESENCE",
          result: PresenceResult.SUCCESS,
          timestamp: now
        }
      });

      if (process.env.NODE_ENV === "development") {
        console.log("✅ SUCCESS: Presence verified", {
          customerId,
          distance: `${Math.round(distanceMeters)} meters`,
          allowedRadius: `${cafeConfig.allowedRadiusMeters} meters`,
          accuracy: data.accuracy !== undefined ? `${Math.round(data.accuracy)} meters` : undefined,
          presenceLogId: presenceLog.id
        });
      }

      successResponse(
        res,
        {
          status: "SUCCESS",
          decision: "INSIDE_CAFE",
          verified: true,
          presenceLogId: presenceLog.id,
          distanceMeters: Math.round(distanceMeters * 100) / 100,
          allowedRadiusMeters: cafeConfig.allowedRadiusMeters,
          verifiedAt: presenceLog.timestamp
        },
        "Cafe presence verified successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /logs
 *
 * Employee views presence logs.
 */
router.get(
  "/logs",
  authenticateEmployee,
  authorizePermission(
    Permission.PRESENCE_VIEW,
    Permission.PRESENCE_MANAGE
  ),
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const {
        customerId,
        result,
        limit,
        offset
      } = logsQuerySchema.parse(req.query);

      const where = {
        ...(customerId !== undefined
          ? { customerId }
          : {}),
        ...(result !== undefined
          ? { result }
          : {})
      };

      const [logs, total] =
        await prisma.$transaction([
          prisma.presenceLog.findMany({
            where,
            include: {
              customer: {
                select: {
                  id: true,
                  name: true,
                  phone: true
                }
              },
              device: {
                select: {
                  id: true,
                  deviceId: true,
                  status: true
                }
              },
              qrToken: {
                select: {
                  id: true,
                  status: true,
                  consumedAt: true
                }
              }
            },
            orderBy: {
              timestamp: "desc"
            },
            skip: offset,
            take: limit
          }),
          prisma.presenceLog.count({
            where
          })
        ]);

      successResponse(
        res,
        {
          logs,
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + logs.length < total
          }
        },
        "Presence logs retrieved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

export default router;