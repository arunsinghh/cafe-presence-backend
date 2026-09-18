import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { Request } from "express";

export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp"
];

const UPLOADS_ROOT = path.resolve("uploads");
export const VOUCHER_UPLOADS_DIR = path.join(UPLOADS_ROOT, "vouchers");
export const BENEFIT_UPLOADS_DIR = path.join(UPLOADS_ROOT, "benefits");

// Ensure upload directories exist
for (const dir of [UPLOADS_ROOT, VOUCHER_UPLOADS_DIR, BENEFIT_UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Validates file buffer magic bytes to ensure file is genuinely a JPEG, PNG, or WebP.
 * Does not trust the file extension or declared mime-type alone.
 */
export function validateImageMagicBytes(buffer: Buffer): { isValid: boolean; extension: string } {
  if (!buffer || buffer.length < 12) {
    return { isValid: false, extension: "" };
  }

  // 1. JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { isValid: true, extension: "jpg" };
  }

  // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { isValid: true, extension: "png" };
  }

  // 3. WebP: RIFF ... WEBP
  // Byte 0-3: "RIFF" (0x52 0x49 0x46 0x46)
  // Byte 8-11: "WEBP" (0x57 0x45 0x42 0x50)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { isValid: true, extension: "webp" };
  }

  return { isValid: false, extension: "" };
}

/**
 * Saves a validated image buffer to disk with a secure random filename.
 */
export function saveImageBuffer(buffer: Buffer, subDir: "vouchers" | "benefits"): string {
  const { isValid, extension } = validateImageMagicBytes(buffer);
  if (!isValid) {
    throw new Error("Invalid image format. Allowed formats: JPEG, PNG, WebP");
  }

  const targetDir = subDir === "vouchers" ? VOUCHER_UPLOADS_DIR : BENEFIT_UPLOADS_DIR;
  const safeFilename = `${subDir}_${Date.now()}_${crypto.randomBytes(8).toString("hex")}.${extension}`;
  const targetPath = path.join(targetDir, safeFilename);

  fs.writeFileSync(targetPath, buffer);
  return `/uploads/${subDir}/${safeFilename}`;
}

/**
 * Safely removes an image file from disk if it belongs to /uploads/
 */
export function removeImageFile(imageRelativeUrl: string | null | undefined): void {
  if (!imageRelativeUrl || typeof imageRelativeUrl !== "string") return;
  if (!imageRelativeUrl.startsWith("/uploads/")) return;

  try {
    const sanitizedRelative = imageRelativeUrl.replace(/^\/uploads\//, "");
    const fullPath = path.join(UPLOADS_ROOT, sanitizedRelative);
    // Prevent path traversal
    if (fullPath.startsWith(UPLOADS_ROOT) && fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  } catch (err) {
    console.warn("Failed to remove image file:", imageRelativeUrl, err);
  }
}

// Multer in-memory storage so we can validate magic bytes before committing to disk
export const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE
  },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype.toLowerCase())) {
      cb(new Error("Unsupported file type. Only JPEG, PNG, and WebP images are allowed."));
      return;
    }
    cb(null, true);
  }
});

