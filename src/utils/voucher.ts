import { VoucherStatus } from "@prisma/client";

/**
 * Formats a CustomerVoucher database record into a comprehensive payload
 * containing all fields expected by Android mobile apps and Admin web portals.
 *
 * Enforces strict Active Voucher Rules:
 * - Customer voucher must belong to the customer
 * - Not redeemed (if cv.status === REDEEMED or cv.redeemedAt !== null -> REDEEMED)
 * - Not expired (if cv.expiresAt or v.expiresAt is past -> EXPIRED)
 * - Template status must also be ACTIVE (if v.status === REVOKED/EXPIRED -> not ACTIVE)
 * - value and minSpend are always numbers (never null) to prevent Kotlin primitive Double crashes.
 */
export function formatCustomerVoucherItem(cv: any) {
  const v = cv.voucher || {};
  const expiresAt = cv.expiresAt || v.expiresAt || null;
  const now = new Date();

  // 1. Expiration evaluation
  const isExpired =
    cv.status === VoucherStatus.EXPIRED ||
    v.status === VoucherStatus.EXPIRED ||
    (expiresAt !== null && new Date(expiresAt) <= now);

  // 2. Redemption evaluation
  const isRedeemed =
    cv.status === VoucherStatus.REDEEMED ||
    cv.redeemedAt !== null;

  // 3. Revocation evaluation
  const isRevoked =
    cv.status === VoucherStatus.REVOKED ||
    v.status === VoucherStatus.REVOKED;

  // 4. Authoritative Effective Status
  let effectiveStatus: VoucherStatus = VoucherStatus.ACTIVE;
  if (isRedeemed) {
    effectiveStatus = VoucherStatus.REDEEMED;
  } else if (isRevoked) {
    effectiveStatus = VoucherStatus.REVOKED;
  } else if (isExpired) {
    effectiveStatus = VoucherStatus.EXPIRED;
  } else if (cv.status === VoucherStatus.ACTIVE && v.status === VoucherStatus.ACTIVE) {
    effectiveStatus = VoucherStatus.ACTIVE;
  } else {
    effectiveStatus = cv.status;
  }

  const numericValue =
    v.value !== null && v.value !== undefined ? Number(v.value) : 0;

  const imageUrl = v.imageUrl || null;

  return {
    // Identifiers
    id: cv.id,                          // CustomerVoucher ID
    customerVoucherId: cv.id,          // Explicit alias
    voucherId: cv.voucherId,           // Voucher template ID
    customerId: cv.customerId,

    // Metadata & Display
    code: v.code || "",
    name: v.name || "",
    title: v.name || "",                // Android commonly binds to title
    description: v.description || "",
    details: v.description || "",
    type: v.type || "PERCENTAGE",
    value: numericValue,                // Non-null number: safe for Android Kotlin primitive Double
    discount: numericValue,             // Explicit discount property for Android & Admin
    minSpend: 0,                        // Explicit non-null Double for Android
    image: imageUrl,
    imageUrl: imageUrl,

    // Status & Redemption
    status: effectiveStatus,
    isRedeemed: effectiveStatus === VoucherStatus.REDEEMED,
    isExpired: Boolean(isExpired),
    redeemedAt: cv.redeemedAt || null,
    redeemedCount: v.redeemedCount || 0,
    maxRedemptions: v.maxRedemptions || null,

    // Validity / Dates
    issuedAt: cv.issuedAt,
    expiresAt: expiresAt,
    validity: expiresAt,
    startsAt: v.startsAt || null,
    createdAt: cv.createdAt,
    updatedAt: cv.updatedAt,

    // Nested relations for maximum compatibility
    voucher: {
      id: v.id,
      code: v.code || "",
      name: v.name || "",
      title: v.name || "",
      description: v.description || "",
      type: v.type || "PERCENTAGE",
      value: numericValue,
      discount: numericValue,
      minSpend: 0,
      imageUrl: imageUrl,
      image: imageUrl,
      maxRedemptions: v.maxRedemptions || null,
      redeemedCount: v.redeemedCount || 0,
      startsAt: v.startsAt || null,
      expiresAt: v.expiresAt || null,
      status: v.status || VoucherStatus.ACTIVE,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt
    },
    customer: cv.customer || undefined
  };
}
