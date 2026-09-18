import jwt from "jsonwebtoken";

export interface EmployeeTokenPayload {
  id: number;
  role: string;
}

export interface CustomerTokenPayload {
  customerId: number;
  deviceId: string;
}

export type TokenPayload =
  | EmployeeTokenPayload
  | CustomerTokenPayload;

const getEmployeeSecret = (): string => {
  const secret = process.env.JWT_EMPLOYEE_SECRET;

  if (!secret) {
    throw new Error(
      "JWT_EMPLOYEE_SECRET is not configured"
    );
  }

  return secret;
};

const getCustomerSecret = (): string => {
  const secret = process.env.JWT_CUSTOMER_SECRET;

  if (!secret) {
    throw new Error(
      "JWT_CUSTOMER_SECRET is not configured"
    );
  }

  return secret;
};

export const generateToken = (
  payload: TokenPayload,
  expiresIn?: string
): string => {
  const isCustomerToken =
    "customerId" in payload;

  const secret = isCustomerToken
    ? getCustomerSecret()
    : getEmployeeSecret();

  const defaultExpiresIn = isCustomerToken
    ? process.env.JWT_CUSTOMER_EXPIRES_IN || "7d"
    : process.env.JWT_EMPLOYEE_EXPIRES_IN || "8h";

  return jwt.sign(
    payload,
    secret,
    {
      expiresIn:
        expiresIn || defaultExpiresIn,
    } as jwt.SignOptions
  );
};

export const verifyToken = (
  token: string
): TokenPayload => {
  let decoded: string | jwt.JwtPayload;

  try {
    decoded = jwt.verify(
      token,
      getEmployeeSecret()
    );
  } catch {
    try {
      decoded = jwt.verify(
        token,
        getCustomerSecret()
      );
    } catch {
      throw new Error(
        "Invalid or expired token"
      );
    }
  }

  if (
    typeof decoded === "string" ||
    !decoded
  ) {
    throw new Error(
      "Invalid token payload"
    );
  }

  if (
    typeof decoded.id === "number" &&
    typeof decoded.role === "string"
  ) {
    return {
      id: decoded.id,
      role: decoded.role,
    };
  }

  if (
    typeof decoded.customerId === "number" &&
    typeof decoded.deviceId === "string"
  ) {
    return {
      customerId: decoded.customerId,
      deviceId: decoded.deviceId,
    };
  }

  /*
   * Supports an older customer token where
   * deviceId was accidentally generated as a number.
   */

  throw new Error(
    "Invalid token payload"
  );
};