import { NextFunction, Request, Response } from "express";
import { ZodTypeAny } from "zod";

export const validate =
  (schema: ZodTypeAny) =>
  (
    req: Request,
    res: Response,
    next: NextFunction
  ): void => {
    try {
      const result = schema.safeParse({
        body: req.body,
        query: req.query,
        params: req.params,
      });

      if (!result.success) {
        res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });

        return;
      }

      if (
        result.data &&
        typeof result.data === "object"
      ) {
        const data = result.data as {
          body?: unknown;
          query?: unknown;
          params?: unknown;
        };

        if (data.body !== undefined) {
          req.body = data.body;
        }

        if (data.query !== undefined) {
          req.query = data.query as Request["query"];
        }

        if (data.params !== undefined) {
          req.params = data.params as Request["params"];
        }
      }

      next();
    } catch (error) {
      next(error);
    }
  };