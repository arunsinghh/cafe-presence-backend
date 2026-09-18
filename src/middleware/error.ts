import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { errorResponse } from "../utils/response";

export const errorMiddleware = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): Response => {
  console.error(error);

  if (error instanceof ZodError) {
    return errorResponse(
      res,
      "Validation failed",
      400,
      error.flatten()
    );
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return errorResponse(
        res,
        "A record with the provided value already exists",
        409
      );
    }

    if (error.code === "P2025") {
      return errorResponse(
        res,
        "Record not found",
        404
      );
    }

    return errorResponse(
      res,
      "Database operation failed",
      500
    );
  }

  if (error instanceof Error) {
    return errorResponse(
      res,
      error.message || "Internal server error",
      500
    );
  }

  return errorResponse(
    res,
    "Internal server error",
    500
  );
};