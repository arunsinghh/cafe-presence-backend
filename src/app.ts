import express from "express";
import cors from "cors";
import path from "path";

import routes from "./routes";
import { errorMiddleware } from "./middleware/error";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true
  })
);

app.use(express.json());
app.use(
  express.urlencoded({
    extended: true
  })
);

// Serve static uploaded assets
const uploadsPath = path.resolve("uploads");
app.use("/uploads", express.static(uploadsPath));
app.use("/api/uploads", express.static(uploadsPath));

// Root route
app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Cafe Presence Backend API is running",
    health: "/health",
    api: "/api"
  });
});

// Health check
app.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Cafe Presence Backend is healthy"
  });
});

// API routes
app.use("/api", routes);

// Global error handler - must be last
app.use(errorMiddleware);

export default app;