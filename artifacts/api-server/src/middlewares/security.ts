/**
 * GEMS Security Layer
 *
 * Rate limiting, helmet headers, anti-bot protection, and content moderation.
 */

import { Request, Response, NextFunction } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Rate Limiters
// ---------------------------------------------------------------------------

/** Auth endpoints (login / register): 10 requests per 15 minutes per IP */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests", message: "Too many login attempts. Please try again in 15 minutes." },
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  handler: (req, res) => {
    logger.warn({ ip: req.ip, path: req.path }, "Auth rate limit exceeded");
    res.status(429).json({ error: "Too many requests", message: "Too many login attempts. Please try again in 15 minutes." });
  },
});

/** General API: 200 requests per minute per IP */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests", message: "Rate limit exceeded. Please slow down." },
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  handler: (req, res) => {
    logger.warn({ ip: req.ip, path: req.path }, "General rate limit exceeded");
    res.status(429).json({ error: "Too many requests", message: "Rate limit exceeded. Please slow down." });
  },
});

/** Video creation: 10 per hour per user (or IP if unauthenticated) */
export const videoCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests", message: "Video creation limit reached. You may create up to 10 videos per hour." },
  keyGenerator: (req) => (req as any).user?.userId ?? ipKeyGenerator(req.ip ?? ""),
  skip: (req) => (req as any).user?.role === "super_admin",
  handler: (req, res) => {
    logger.warn({ userId: (req as any).user?.userId, ip: req.ip }, "Video creation rate limit exceeded");
    res.status(429).json({ error: "Too many requests", message: "Video creation limit reached. You may create up to 10 videos per hour." });
  },
});

/** Admin endpoints: 60 requests per minute per IP */
export const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests", message: "Admin endpoint rate limit exceeded." },
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  handler: (req, res) => {
    logger.warn({ ip: req.ip, path: req.path }, "Admin rate limit exceeded");
    res.status(429).json({ error: "Too many requests", message: "Admin endpoint rate limit exceeded." });
  },
});

// ---------------------------------------------------------------------------
// Security Headers (Helmet config — applied in app.ts)
// ---------------------------------------------------------------------------

export const helmetConfig = {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
};

// ---------------------------------------------------------------------------
// Anti-bot Middleware
// ---------------------------------------------------------------------------

const BOT_UA_PATTERNS = [
  /curl\//i,
  /python-requests/i,
  /go-http-client/i,
  /java\//i,
  /scrapy/i,
  /wget\//i,
  /libwww-perl/i,
  /masscan/i,
  /nikto/i,
  /nmap/i,
  /sqlmap/i,
  /dirbuster/i,
  /hydra/i,
  /metasploit/i,
];

// Routes that are safe to access without a browser-like UA (API / health / admin)
const UA_BYPASS_PATHS = ["/api/health", "/api/auth"];

export function antiBotMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ua = req.headers["user-agent"] ?? "";
  const path = req.path;

  // Skip health and auth endpoints
  if (UA_BYPASS_PATHS.some((p) => path.startsWith(p))) {
    return next();
  }

  // Block known attack tools
  if (BOT_UA_PATTERNS.some((p) => p.test(ua))) {
    logger.warn({ ip: req.ip, ua, path }, "Anti-bot: blocked suspicious user-agent");
    res.status(403).json({ error: "Forbidden", message: "Automated access is not permitted." });
    return;
  }

  // Suspicious: completely missing UA on non-health routes
  if (!ua && req.method !== "GET") {
    logger.warn({ ip: req.ip, path, method: req.method }, "Anti-bot: blocked empty user-agent on mutation");
    res.status(403).json({ error: "Forbidden", message: "Invalid request." });
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// Content Moderation
// ---------------------------------------------------------------------------

/** Categories flagged by OpenAI moderation — any match blocks submission */
const BLOCKED_CATEGORIES = [
  "hate",
  "hate/threatening",
  "harassment",
  "harassment/threatening",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "sexual",
  "sexual/minors",
  "violence",
  "violence/graphic",
];

/**
 * Moderate text content using OpenAI's moderation endpoint.
 * Returns null if content is safe, or a string describing the violation.
 */
export async function moderateContent(text: string): Promise<string | null> {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn("Content moderation: OPENAI_API_KEY not set — skipping moderation");
      return null;
    }

    const response = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: text.slice(0, 2000) }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, "Content moderation API error — skipping");
      return null;
    }

    const data = await response.json() as {
      results: Array<{
        flagged: boolean;
        categories: Record<string, boolean>;
      }>;
    };

    const result = data.results?.[0];
    if (!result?.flagged) return null;

    const violations = BLOCKED_CATEGORIES.filter((cat) => result.categories[cat]);
    return violations.length > 0
      ? `Content flagged: ${violations.join(", ")}`
      : "Content flagged by moderation system";
  } catch (err) {
    logger.warn({ err }, "Content moderation failed — skipping");
    return null;
  }
}
