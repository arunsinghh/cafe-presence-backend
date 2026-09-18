import crypto from "crypto";

import {
  DeviceStatus,
  PresenceMethod,
  PresenceResult,
} from "@prisma/client";

import { prisma } from "../config/prisma";

/* =========================================================
   APPLICATION ERROR
   ========================================================= */

export class AppError extends Error {
  public readonly statusCode: number;

  constructor(
    statusCode: number,
    message: string
  ) {
    super(message);

    this.statusCode = statusCode;

    Object.setPrototypeOf(
      this,
      AppError.prototype
    );
  }
}

/* =========================================================
   LOCATION DISTANCE
   HAVERSINE FORMULA
   ========================================================= */

export const distanceMeters = (
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number
): number => {
  const earthRadius = 6_371_000;

  const toRadians = (
    degrees: number
  ): number =>
    (degrees * Math.PI) / 180;

  const lat1 = toRadians(latitude1);
  const lat2 = toRadians(latitude2);

  const deltaLatitude =
    toRadians(latitude2 - latitude1);

  const deltaLongitude =
    toRadians(longitude2 - longitude1);

  const a =
    Math.sin(
      deltaLatitude / 2
    ) *
      Math.sin(
        deltaLatitude / 2
      ) +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(
        deltaLongitude / 2
      ) *
      Math.sin(
        deltaLongitude / 2
      );

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return earthRadius * c;
};

/* =========================================================
   AUDIT LOG
   ========================================================= */

export const audit = async (
  employeeId: number,
  action: string,
  entityType?: string,
  entityId?: string,
  details?: unknown
) => {
  return prisma.auditLog.create({
    data: {
      employeeId,
      action,
      entityType,
      entityId,
      details:
        details === undefined
          ? undefined
          : (details as any),
    },
  });
};

/* =========================================================
   APPROVE DEVICE
   ========================================================= */

export async function approveDevice(
  employeeId: number,
  deviceId: number
) {
  return prisma.$transaction(
    async (tx) => {
      const device =
        await tx.device.findUnique({
          where: {
            id: deviceId,
          },
        });

      if (!device) {
        throw new AppError(
          404,
          "Device not found"
        );
      }

      /*
       * Revoke other active devices
       * belonging to the same customer.
       */
      await tx.device.updateMany({
        where: {
          customerId:
            device.customerId,

          status:
            DeviceStatus.ACTIVE,

          id: {
            not: deviceId,
          },
        },

        data: {
          status:
            DeviceStatus.REVOKED,

          revokedAt:
            new Date(),
        },
      });

      /*
       * Activate selected device.
       */
      const activeDevice =
        await tx.device.update({
          where: {
            id: deviceId,
          },

          data: {
            status:
              DeviceStatus.ACTIVE,

            approvedAt:
              new Date(),

            revokedAt:
              null,

            lostAt:
              null,
          },
        });

      await tx.auditLog.create({
        data: {
          employeeId,

          action:
            "DEVICE_APPROVED",

          entityType:
            "Device",

          entityId:
            String(deviceId),

          details: {
            customerId:
              device.customerId,

            deviceIdentifier:
              device.deviceId,
          },
        },
      });

      return activeDevice;
    }
  );
}

/* =========================================================
   VERIFY GPS LOCATION (GPS ONLY)
   ========================================================= */

interface LocationVerificationData {
  latitude: number;
  longitude: number;
  accuracy?: number;
  purpose?: string;
}

export async function verifyLocation(
  customerId: number,
  deviceId: number,
  body: LocationVerificationData
) {
  /*
   * Verify customer.
   */
  const customer =
    await prisma.customer.findUnique({
      where: {
        id: customerId,
      },
    });

  if (!customer) {
    throw new AppError(
      404,
      "Customer not found"
    );
  }

  /*
   * Verify device belongs to customer.
   */
  const device =
    await prisma.device.findFirst({
      where: {
        id: deviceId,
        customerId,
      },
    });

  if (!device) {
    throw new AppError(
      404,
      "Device not found"
    );
  }

  if (
    device.status !==
    DeviceStatus.ACTIVE
  ) {
    throw new AppError(
      403,
      "Device is not active"
    );
  }

  const cafeConfig =
    await prisma.cafeConfig.findFirst();

  if (!cafeConfig) {
    throw new AppError(
      500,
      "Cafe configuration is missing"
    );
  }

  if (!cafeConfig.isPresenceEnabled) {
    throw new AppError(
      403,
      "Presence verification is currently disabled"
    );
  }

  const distance =
    distanceMeters(
      body.latitude,
      body.longitude,
      cafeConfig.latitude,
      cafeConfig.longitude
    );

  /*
   * GPS accuracy is considered because
   * mobile GPS can have an uncertainty
   * radius.
   */
  const accuracy =
    body.accuracy ?? 0;

  const allowedDistance =
    cafeConfig.allowedRadiusMeters +
    accuracy;

  const success =
    distance <= allowedDistance;

  return prisma.presenceLog.create({
    data: {
      customerId,

      deviceId,

      method:
        PresenceMethod.GPS,

      result:
        success
          ? PresenceResult.SUCCESS
          : PresenceResult.FAILED,

      purpose:
        body.purpose,

      latitude:
        body.latitude,

      longitude:
        body.longitude,

      accuracy:
        body.accuracy,

      distanceMeters:
        distance,
    },
  });
}