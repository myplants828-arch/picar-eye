import express from "express";
import multer from "multer";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PHOTO_PATH = join(__dirname, "current.jpg");
const METADATA_PATH = join(__dirname, "metadata.json");
const PORT = process.env.PORT || 3847;

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// MCP session management
const transports = {};

const mcpTools = [
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
];

function handleMcpTool(name, args) {
  if (name === "get_photo") {
    if (!existsSync(PHOTO_PATH)) {
      return { content: [{ type: "text", text: "No photo available yet. Ask Elys to take one!" }] };
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
      return { content: [{ type: "text", text: "No photo available yet." }] };
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
}

function createMcpServer() {
  const server = new Server(
    { name: "picar-eye", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return handleMcpTool(name, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// Phone upload endpoint
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

// Status endpoint
app.get("/status", (req, res) => {
  if (existsSync(METADATA_PATH)) {
    const meta = JSON.parse(readFileSync(METADATA_PATH, "utf-8"));
    res.json({ hasPhoto: true, ...meta });
  } else {
    res.json({ hasPhoto: false });
  }
});

// Photo as base64 JSON
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

// Photo as raw image
app.get("/photo.jpg", (req, res) => {
  if (!existsSync(PHOTO_PATH)) {
    return res.status(404).send("No photo available");
  }
  res.sendFile(PHOTO_PATH);
});

// MCP Streamable HTTP endpoint
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  try {
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
          console.log(`MCP session initialized: ${sid}`);
        }
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
          console.log(`MCP session closed: ${sid}`);
        }
      };
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID" }, id: null });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PiCar Eye running on port ${PORT}`);
  console.log(`MCP endpoint: /mcp`);
  console.log(`Phone upload: /upload`);
});
