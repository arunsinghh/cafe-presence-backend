import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";

export interface AuditLogData {
  employeeId: number;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Prisma.InputJsonValue;
  ipAddress?: string;
  userAgent?: string;
}

export const logAudit = async (
  data: AuditLogData
): Promise<void> => {
  await prisma.auditLog.create({
    data: {
      employeeId: data.employeeId,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId,
      details: data.details,
      ipAddress: data.ipAddress,
      userAgent: data.userAgent
    }
  });
};