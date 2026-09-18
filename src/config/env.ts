import dotenv from "dotenv";

dotenv.config();

const requiredEnv = (
  name: string
): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Environment variable ${name} is required`
    );
  }

  return value;
};

const PORT = Number(
  process.env.PORT || 4000
);

if (!Number.isInteger(PORT) || PORT <= 0) {
  throw new Error("PORT must be a valid positive number");
}

export const env = {
  NODE_ENV:
    process.env.NODE_ENV || "development",

  PORT,

  DATABASE_URL: requiredEnv("DATABASE_URL"),

  JWT_CUSTOMER_SECRET: requiredEnv(
    "JWT_CUSTOMER_SECRET"
  ),

  JWT_EMPLOYEE_SECRET: requiredEnv(
    "JWT_EMPLOYEE_SECRET"
  ),

  JWT_CUSTOMER_EXPIRES_IN:
    process.env.JWT_CUSTOMER_EXPIRES_IN || "7d",

  JWT_EMPLOYEE_EXPIRES_IN:
    process.env.JWT_EMPLOYEE_EXPIRES_IN || "8h",

  BCRYPT_SALT_ROUNDS: Number(
    process.env.BCRYPT_SALT_ROUNDS || 12
  ),

  INITIAL_ADMIN_EMAIL:
    process.env.INITIAL_ADMIN_EMAIL ||
    "admin@example.com",

  INITIAL_ADMIN_PASSWORD:
    process.env.INITIAL_ADMIN_PASSWORD ||
    "Admin@123"
};