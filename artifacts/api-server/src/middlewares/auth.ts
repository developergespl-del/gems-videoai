import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

const JWT_SECRET = process.env.SESSION_SECRET || "gems-video-ai-secret-key";

const JWT_ALGORITHM = "HS256";

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d", algorithm: JWT_ALGORITHM });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] }) as JwtPayload;
  } catch {
    return null;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized", message: "No token provided" });
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
    return;
  }

  // Check live user status from DB for immediate blocking effect
  try {
    const [user] = await db
      .select({ status: usersTable.status, role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, payload.userId));

    if (!user) {
      res.status(401).json({ error: "Unauthorized", message: "User not found" });
      return;
    }

    // Super admin is the absolute system owner — status checks never apply
    if (user.role !== "super_admin") {
      if (user.status === "blocked") {
        res.status(403).json({ error: "Forbidden", message: "Your account has been suspended." });
        return;
      }

      if (user.status === "terminated") {
        res.status(403).json({ error: "Forbidden", message: "Your account has been terminated." });
        return;
      }

      if (user.status === "blacklisted") {
        res.status(403).json({ error: "Forbidden", message: "Your account has been blacklisted. Please contact support." });
        return;
      }
    }

    // Use DB role (authoritative) rather than JWT role
    req.user = { ...payload, role: user.role };
    next();
  } catch (err) {
    logger.error(err, "requireAuth DB status check failed");
    res.status(500).json({ error: "internal_error" });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
      return;
    }
    next();
  };
}
