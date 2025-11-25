require("dotenv").config();
require("dotenv").config({ path: ".env.firebase" });

console.log("🟢 server.js loaded — this is the latest instance");

const fs = require("fs");
const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
function sanitizeUri(u = "") {
  return u
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

let uri = sanitizeUri(process.env.DOCUMENTDB_URI || "");

const cors = require("cors");
const cookieParser = require("cookie-parser");

// Route imports
const authRoutes = require("./routes/auth");
const newsRoutes = require("./routes/news");
const exploreCourtRoutes = require("./routes/exploreCourt");
const homeRoutes = require("./routes/home");
const caseRoutes = require("./routes/case");
const documentRoutes = require("./routes/document");
const ordersRoutes = require("./routes/orders");
const announcementRoutes = require("./routes/announcements");
const subscriptionRoutes = require("./routes/subscription");
const courtRoutes = require("./routes/courts");
const testDocumentDbRoute = require("./routes/test-documentdb");
const aiDraftingRoutes = require("./routes/aiDrafting");
const notificationsRoutes = require("./routes/notifications");
const generalDocumentRoutes = require("./routes/generalDocument");
const bailRosterRoutes = require("./routes/bailRoster");
const judgesListRoutes = require("./routes/judgesList");
const exploreFormRoutes = require("./routes/explore");
const paymentRoutes = require("./routes/payment");
const googleAuthRoutes = require("./routes/googleAuth");
const mobilePaymentRoutes = require("./routes/mobilepayement.route");

// 🚀 NEW: Delhi District Courts PDF API (complex → zone → category)
const ddcRoutes = require("./routes/ddc"); // <-- add this

// 🚀 NEW: VC details API (judge name/room/link table)
const courtVCRoutes = require("./routes/courtvc"); // <-- add this

// CauseList route
const causeListRoute = require("./routes/causeList");

const app = express();

/* ================== MIDDLEWARE ================== */

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://lawgikalai-admin.netlify.app",
  "https://lawgikalai.com",
  "http://lawgikalai.com",
  "https://www.lawgikalai.com",
  "http://www.lawgikalai.com",
  "http://10.0.1.97:5173",
  "http://3.108.191.82:5174",
  "http://10.0.140.68:4000", // optional internal
  "https://admin.lawgikalai.com", // ✅ added your new admin panel
  "http://admin.lawgikalai.com",
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // allow REST tools like Postman
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions)); // Apply globally
app.options("*", cors(corsOptions)); // Preflight requests

app.set("trust proxy", 1);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(cookieParser());

// Ensure uploads directory exists
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads", { recursive: true });
}

// Serve uploads (PDFs inline)
app.use(
  "/uploads",
  express.static("uploads", {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".pdf")) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", "inline");
      }
    },
  })
);

require("./jobs/notificationScheduler");

/* ================== ROUTES ================== */

app.use("/api/auth", authRoutes);
app.use("/api/news", newsRoutes);
app.use("/api/explore", exploreCourtRoutes);
app.use("/api/home", homeRoutes);
app.use("/api/case", caseRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/orders", ordersRoutes); // ✅ keep only this
app.use("/api/announcements", announcementRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/ai", aiDraftingRoutes);
app.use("/api/explore/courts", courtRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/test", testDocumentDbRoute);
// Changed here the route handling
app.use("/api/courts", causeListRoute);
app.use("/api/general-document", generalDocumentRoutes);

// 🔌 NEW mounts
app.use("/api/ddc", ddcRoutes); // UI structure + upload + search over PDFs
app.use("/api/court-vc", courtVCRoutes); // VC table CRUD/search

app.use("/api/bailroster", bailRosterRoutes);
app.use("/api/judgelist", judgesListRoutes);
app.use("/api/explore-form", exploreFormRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/mobilepayment", mobilePaymentRoutes);
app.use("/api/google", googleAuthRoutes);

// Health / base
app.get("/", (_req, res) => {
  res.send("Welcome to Lawgikalai Auth API! 🚀");
});

/* ================== DATABASE CONNECT & SERVER START ================== */

mongoose.set("bufferCommands", false);
mongoose.set("bufferTimeoutMS", 0);

const DOCUMENTDB_URI = process.env.DOCUMENTDB_URI || process.env.MONGODB_URI;

const caFromEnv = process.env.DOCDB_CA;
const caPath = caFromEnv
  ? path.isAbsolute(caFromEnv)
    ? caFromEnv
    : path.resolve(process.cwd(), caFromEnv)
  : null;

const mongoOpts = {
  retryWrites: false,
  tls: true,
  serverSelectionTimeoutMS: 15000,
  socketTimeoutMS: 45000,
};

if (caPath && fs.existsSync(caPath)) {
  mongoOpts.tlsCAFile = caPath;
} else {
  console.warn(
    "⚠️  DOCDB_CA not found or not set. TLS is enabled without custom CA."
  );
  if (caPath) console.warn("   Expected at:", caPath);
}

const PORT = Number(process.env.PORT) || 4000;

async function start() {
  try {
    if (!DOCUMENTDB_URI) {
      throw new Error("DOCUMENTDB_URI (or MONGODB_URI) is not set.");
    }
    await mongoose.connect(DOCUMENTDB_URI, mongoOpts);
    console.log("✅ Connected to DocumentDB");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Server running on 0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error("❌ DocumentDB connection error:", err);
    //  app.listen(PORT, "0.0.0.0", () => {
    //   console.log(`✅ Server running on 0.0.0.0:${PORT}`);
    // });
    process.exit(1);
  }
}

start();

module.exports = app;
