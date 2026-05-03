import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  generalLimiter,
  antiBotMiddleware,
  helmetConfig,
} from "./middlewares/security";

const app: Express = express();

// ── Security headers (HSTS, X-Content-Type-Options, X-Frame-Options, etc.) ──
app.use(helmet(helmetConfig));
app.get("/api", (req, res) => {
  res.send("API WORKING 🚀");
});
app.post("/video", (req, res) => {
  res.json({ message: "VIDEO ROUTE WORKING 🚀" });
});
// ── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors());

// ── Anti-bot protection ───────────────────────────────────────────────────────
app.use(antiBotMiddleware);

// ── General rate limiter (200 req/min per IP) ─────────────────────────────────
app.use("/api", generalLimiter);

// ── Request logging ───────────────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
