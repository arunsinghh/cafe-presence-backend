import { Router, Request, Response, NextFunction } from "express";
import { Permission } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../config/prisma";
import {
  AuthenticatedRequest,
  authenticateEmployee,
  authenticateCustomerDevice
} from "../middleware/auth";
import { authorizePermission } from "../middleware/permission";
import { errorResponse, successResponse } from "../utils/response";
import { logAudit } from "../utils/audit";
import {
  uploadMemory,
  saveImageBuffer,
  removeImageFile
} from "../utils/upload";

const router = Router();

const benefitIdSchema = z.object({
  id: z.coerce.number().int().positive()
});

const createBenefitSchema = z.object({
  title: z.string().trim().min(1).max(150),
  description: z.string().trim().min(1).max(500),
  imageUrl: z.string().trim().nullable().optional(),
  active: z.coerce.boolean().optional().default(true),
  displayOrder: z.coerce.number().int().optional().default(0)
});

const updateBenefitSchema = z.object({
  title: z.string().trim().min(1).max(150).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  imageUrl: z.string().trim().nullable().optional(),
  active: z.coerce.boolean().optional(),
  displayOrder: z.coerce.number().int().optional()
});

/**
 * Ensures the 3 default benefits exist if the table is empty.
 */
export async function ensureDefaultBenefits(): Promise<void> {
  try {
    const count = await prisma.benefit.count();
    if (count === 0) {
      await prisma.benefit.createMany({
        data: [
          {
            title: "Dining Discounts",
            description: "Valid in Lounge",
            displayOrder: 1,
            active: true
          },
          {
            title: "Complimentary Brew",
            description: "Classic Reward",
            displayOrder: 2,
            active: true
          },
          {
            title: "Priority Lounge Seating",
            description: "Member Benefit",
            displayOrder: 3,
            active: true
          }
        ]
      });
    }
  } catch (err) {
    console.warn("Could not check/seed default benefits:", err);
  }
}

function formatBenefit(b: any) {
  return {
    id: b.id,
    title: b.title,
    description: b.description,
    subtitle: b.description, // Android card compatibility
    imageUrl: b.imageUrl || null,
    image: b.imageUrl || null,
    active: b.active,
    displayOrder: b.displayOrder,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt
  };
}

/**
 * GET /benefits
 *
 * Public & Customer-friendly endpoint: returns active benefits ordered by displayOrder.
 * If employee and ?all=true is passed, returns all benefits.
 */
router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await ensureDefaultBenefits();

      const showAll = req.query.all === "true";

      const benefits = await prisma.benefit.findMany({
        where: showAll ? undefined : { active: true },
        orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }]
      });

      const formatted = benefits.map(formatBenefit);

      res.status(200).json({
        success: true,
        message: "Benefits retrieved successfully",
        data: formatted,
        benefits: formatted
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /benefits/admin
 *
 * Admin view of all benefits (active and inactive).
 */
router.get(
  "/admin",
  authenticateEmployee,
  authorizePermission(
    Permission.CAFE_CONFIG_VIEW,
    Permission.CAFE_CONFIG_MANAGE
  ),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      await ensureDefaultBenefits();

      const benefits = await prisma.benefit.findMany({
        orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }]
      });

      const formatted = benefits.map(formatBenefit);

      res.status(200).json({
        success: true,
        message: "All benefits retrieved successfully",
        data: formatted,
        benefits: formatted
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /benefits
 *
 * Create a new benefit. Supports optional file upload (field 'image').
 */
router.post(
  "/",
  authenticateEmployee,
  authorizePermission(Permission.CAFE_CONFIG_MANAGE),
  uploadMemory.single("image"),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        errorResponse(res, "Employee authentication required", 401);
        return;
      }

      const data = createBenefitSchema.parse(req.body);
      let imageUrl = data.imageUrl || null;

      if (req.file) {
        imageUrl = saveImageBuffer(req.file.buffer, "benefits");
      }

      const benefit = await prisma.benefit.create({
        data: {
          title: data.title,
          description: data.description,
          imageUrl,
          active: data.active,
          displayOrder: data.displayOrder
        }
      });

      await logAudit({
        employeeId: req.user.id,
        action: "BENEFIT_CREATED",
        entityType: "Benefit",
        entityId: String(benefit.id),
        details: {
          title: benefit.title,
          displayOrder: benefit.displayOrder
        },
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });

      successResponse(res, formatBenefit(benefit), "Benefit created successfully", 201);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /benefits/:id & PUT /benefits/:id
 *
 * Update an existing benefit. Supports optional file upload (field 'image').
 */
async function handleUpdateBenefit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      errorResponse(res, "Employee authentication required", 401);
      return;
    }

    const { id } = benefitIdSchema.parse(req.params);
    const data = updateBenefitSchema.parse(req.body);

    const existing = await prisma.benefit.findUnique({
      where: { id }
    });

    if (!existing) {
      errorResponse(res, "Benefit not found", 404);
      return;
    }

    let imageUrl = data.imageUrl !== undefined ? data.imageUrl : existing.imageUrl;

    if (req.file) {
      // Remove old image if present
      removeImageFile(existing.imageUrl);
      imageUrl = saveImageBuffer(req.file.buffer, "benefits");
    } else if (data.imageUrl === null && existing.imageUrl) {
      removeImageFile(existing.imageUrl);
      imageUrl = null;
    }

    const updated = await prisma.benefit.update({
      where: { id },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...(data.displayOrder !== undefined ? { displayOrder: data.displayOrder } : {}),
        imageUrl
      }
    });

    await logAudit({
      employeeId: req.user.id,
      action: "BENEFIT_UPDATED",
      entityType: "Benefit",
      entityId: String(updated.id),
      details: {
        title: updated.title,
        active: updated.active,
        displayOrder: updated.displayOrder
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });

    successResponse(res, formatBenefit(updated), "Benefit updated successfully");
  } catch (error) {
    next(error);
  }
}

router.patch(
  "/:id",
  authenticateEmployee,
  authorizePermission(Permission.CAFE_CONFIG_MANAGE),
  uploadMemory.single("image"),
  handleUpdateBenefit
);

router.put(
  "/:id",
  authenticateEmployee,
  authorizePermission(Permission.CAFE_CONFIG_MANAGE),
  uploadMemory.single("image"),
  handleUpdateBenefit
);

/**
 * POST /benefits/:id/image
 *
 * Dedicated endpoint to upload/replace a benefit's photo.
 */
router.post(
  "/:id/image",
  authenticateEmployee,
  authorizePermission(Permission.CAFE_CONFIG_MANAGE),
  uploadMemory.single("image"),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file) {
        errorResponse(res, "No image file uploaded", 400);
        return;
      }

      const { id } = benefitIdSchema.parse(req.params);
      const existing = await prisma.benefit.findUnique({ where: { id } });

      if (!existing) {
        errorResponse(res, "Benefit not found", 404);
        return;
      }

      removeImageFile(existing.imageUrl);
      const imageUrl = saveImageBuffer(req.file.buffer, "benefits");

      const updated = await prisma.benefit.update({
        where: { id },
        data: { imageUrl }
      });

      successResponse(res, formatBenefit(updated), "Benefit image updated successfully");
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /benefits/:id/image
 *
 * Dedicated endpoint to remove a benefit's photo.
 */
router.delete(
  "/:id/image",
  authenticateEmployee,
  authorizePermission(Permission.CAFE_CONFIG_MANAGE),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = benefitIdSchema.parse(req.params);
      const existing = await prisma.benefit.findUnique({ where: { id } });

      if (!existing) {
        errorResponse(res, "Benefit not found", 404);
        return;
      }

      if (existing.imageUrl) {
        removeImageFile(existing.imageUrl);
      }

      const updated = await prisma.benefit.update({
        where: { id },
        data: { imageUrl: null }
      });

      successResponse(res, formatBenefit(updated), "Benefit image removed successfully");
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /benefits/:id
 *
 * Delete a benefit.
 */
router.delete(
  "/:id",
  authenticateEmployee,
  authorizePermission(Permission.CAFE_CONFIG_MANAGE),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        errorResponse(res, "Employee authentication required", 401);
        return;
      }

      const { id } = benefitIdSchema.parse(req.params);
      const existing = await prisma.benefit.findUnique({ where: { id } });

      if (!existing) {
        errorResponse(res, "Benefit not found", 404);
        return;
      }

      if (existing.imageUrl) {
        removeImageFile(existing.imageUrl);
      }

      await prisma.benefit.delete({ where: { id } });

      await logAudit({
        employeeId: req.user.id,
        action: "BENEFIT_DELETED",
        entityType: "Benefit",
        entityId: String(id),
        details: {
          title: existing.title
        },
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });

      successResponse(res, { id }, "Benefit deleted successfully");
    } catch (error) {
      next(error);
    }
  }
);

export default router;

