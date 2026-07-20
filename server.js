import express from "express";
import multer from "multer";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PHOTO_PATH = join(__dirname, "current.jpg");
const METADATA_PATH = join(__dirname, "metadata.json");
const PORT = process.env.PORT || 3847;

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static(join(__dirname, "public")));

// Upload photo (overwrites previous)
app.post("/upload", upload.single("photo"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No photo provided" });
  }

  writeFileSync(PHOTO_PATH, req.file.buffer);
  writeFileSync(METADATA_PATH, JSON.stringify({
    timestamp: new Date().toISOString(),
    size: req.file.size,
    mimetype: req.file.mimetype,
  }));

  console.log(`Photo received: ${req.file.size} bytes`);
  res.json({ success: true, message: "Photo received" });
});

// Get current photo status
app.get("/status", (req, res) => {
  if (existsSync(METADATA_PATH)) {
    const meta = JSON.parse(readFileSync(METADATA_PATH, "utf-8"));
    res.json({ hasPhoto: true, ...meta });
  } else {
    res.json({ hasPhoto: false });
  }
});

// Get current photo as base64 (for MCP to fetch)
app.get("/photo", (req, res) => {
  if (!existsSync(PHOTO_PATH)) {
    return res.status(404).json({ error: "No photo available" });
  }

  const imageData = readFileSync(PHOTO_PATH);
  const base64 = imageData.toString("base64");
  const meta = existsSync(METADATA_PATH)
    ? JSON.parse(readFileSync(METADATA_PATH, "utf-8"))
    : { mimetype: "image/jpeg" };

  res.json({
    data: base64,
    mimetype: meta.mimetype,
    timestamp: meta.timestamp,
    size: meta.size,
  });
});

// Get current photo as raw image
app.get("/photo.jpg", (req, res) => {
  if (!existsSync(PHOTO_PATH)) {
    return res.status(404).send("No photo available");
  }
  res.sendFile(PHOTO_PATH);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PiCar Eye running on port ${PORT}`);
});
