import { Router } from "express";

import authRoutes from "./auth.routes";
import customerRoutes from "./customer.routes";
import deviceRoutes from "./device.routes";
import presenceRoutes from "./presence.routes";
import voucherRoutes from "./voucher.routes";
import employeeRoutes from "./employee.routes";
import cafeConfigRoutes, { handleGetPublicCafeConfig } from "./cafe-config.routes";
import redemptionRoutes from "./redemption.routes";
import purchaseRoutes from "./purchase.routes";
import benefitRoutes from "./benefit.routes";

const router = Router();

// Top-level public configuration endpoint (for Android ApiService.kt: GET /config)
router.get("/config", handleGetPublicCafeConfig);

router.use("/auth", authRoutes);
router.use("/customers", customerRoutes);
router.use("/devices", deviceRoutes);
router.use("/presence", presenceRoutes);
router.use("/vouchers", voucherRoutes);
router.use("/redemption", redemptionRoutes);
router.use("/employees", employeeRoutes);
router.use("/cafe-config", cafeConfigRoutes);
router.use("/purchases", purchaseRoutes);
router.use("/benefits", benefitRoutes);

export default router;