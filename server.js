import express from "express";
import multer from "multer";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PHOTO_PATH = join(__dirname, "current.jpg");
const METADATA_PATH = join(__dirname, "metadata.json");
const HTTP_PORT = 3847;

// --- Express server for phone uploads ---
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static(join(__dirname, "public")));

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

  console.error(`[picar-eye] Photo received: ${req.file.size} bytes`);
  res.json({ success: true, message: "Photo received" });
});

app.get("/status", (req, res) => {
  if (existsSync(METADATA_PATH)) {
    const meta = JSON.parse(readFileSync(METADATA_PATH, "utf-8"));
    res.json({ hasPhoto: true, ...meta });
  } else {
    res.json({ hasPhoto: false });
  }
});

app.listen(HTTP_PORT, "0.0.0.0", () => {
  console.error(`[picar-eye] HTTP server on http://localhost:${HTTP_PORT}`);
});

// --- MCP server for Claude ---
const mcp = new Server(
  { name: "picar-eye", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_photo",
      description: "Get the latest photo from Elys's phone. Returns the image so I can see it.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "photo_status",
      description: "Check if there's a photo waiting and when it was taken.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === "get_photo") {
    if (!existsSync(PHOTO_PATH)) {
      return {
        content: [{ type: "text", text: "No photo available yet. Ask Elys to take one!" }],
      };
    }

    const imageData = readFileSync(PHOTO_PATH);
    const base64 = imageData.toString("base64");
    const meta = existsSync(METADATA_PATH)
      ? JSON.parse(readFileSync(METADATA_PATH, "utf-8"))
      : {};

    return {
      content: [
        {
          type: "image",
          data: base64,
          mimeType: meta.mimetype || "image/jpeg",
        },
        {
          type: "text",
          text: `Photo from ${meta.timestamp || "unknown time"}`,
        },
      ],
    };
  }

  if (name === "photo_status") {
    if (!existsSync(METADATA_PATH)) {
      return {
        content: [{ type: "text", text: "No photo available yet." }],
      };
    }

    const meta = JSON.parse(readFileSync(METADATA_PATH, "utf-8"));
    return {
      content: [
        {
          type: "text",
          text: `Photo waiting from ${meta.timestamp}. Size: ${Math.round(meta.size / 1024)}KB.`,
        },
      ],
    };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

// Start MCP on stdio
const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error("[picar-eye] MCP server connected");
