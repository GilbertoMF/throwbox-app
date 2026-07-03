// backend/index.ts
import express from "express";
import { createServer as createViteServer } from "vite";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import pkg from "pg";
import crypto from "crypto";
var { Pool } = pkg;
async function startServer() {
  const app = express();
  app.use(express.json({ limit: "15mb" }));
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    next();
  });
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e7
    // 10MB to handle large drawing dataURLs
  });
  const PORT = Number(process.env.PORT) || 3e3;
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
  const STATE_ROW_ID = "global";
  let persistTimer = null;
  const rooms = /* @__PURE__ */ new Map();
  const DEFAULT_OBJECTS = [
    { id: "obj_tesseract", name: "TESSERACT", category: "ARTIFACT", shape: "box", color: "#00F0FF", holderId: null },
    { id: "obj_astral_sphere", name: "ASTRAL_SPHERE", category: "GEOMETRY", shape: "sphere", color: "#FF00FF", holderId: null },
    { id: "obj_prism_core", name: "PRISM_CORE", category: "ARTIFACT", shape: "octahedron", color: "#00FF00", holderId: null },
    { id: "obj_data_cube", name: "DATA_CUBE", category: "GEOMETRY", shape: "box", color: "#FFFF00", holderId: null },
    { id: "obj_void_orb", name: "VOID_ORB", category: "UNKNOWN", shape: "sphere", color: "#FF0000", holderId: null }
  ];
  rooms.set("global", {
    code: "global",
    users: [],
    gameObjects: [...DEFAULT_OBJECTS],
    transferHistory: []
  });
  const MAX_USERS = 5;
  const GRID_SIZE = 3;
  const CROSS_POSITIONS = [
    { x: 1, y: 1 },
    // Center
    { x: 1, y: 0 },
    // Up
    { x: 2, y: 1 },
    // Right
    { x: 1, y: 2 },
    // Down
    { x: 0, y: 1 }
    // Left
  ];
  async function loadPersistedState() {
    if (!pool) return;
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS throwbox_state (
          id TEXT PRIMARY KEY,
          game_objects JSONB NOT NULL DEFAULT '[]',
          transfer_history JSONB NOT NULL DEFAULT '[]',
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS throwbox_users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        
        CREATE TABLE IF NOT EXISTS throwbox_sessions (
          token TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES throwbox_users(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        
        CREATE TABLE IF NOT EXISTS throwbox_user_tokens (
          user_id TEXT PRIMARY KEY REFERENCES throwbox_users(id) ON DELETE CASCADE,
          google_refresh_token TEXT NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      const { rows } = await pool.query(
        "SELECT game_objects, transfer_history FROM throwbox_state WHERE id = $1",
        [STATE_ROW_ID]
      );
      const globalRoom = rooms.get("global");
      if (rows.length > 0) {
        const data = rows[0];
        if (Array.isArray(data.game_objects) && data.game_objects.length > 0) {
          globalRoom.gameObjects = data.game_objects.map((obj) => ({ ...obj, holderId: null }));
        }
        if (Array.isArray(data.transfer_history)) {
          globalRoom.transferHistory = data.transfer_history.slice(0, 50);
        }
        console.log("Loaded state from Postgres");
      } else {
        console.log("No persisted state found, using defaults");
      }
    } catch (err) {
      console.error("Postgres load failed:", err);
    }
  }
  function schedulePersist() {
    if (!pool) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      const globalRoom = rooms.get("global");
      const persistedObjects = globalRoom.gameObjects.map((obj) => ({ ...obj, holderId: null }));
      try {
        await pool.query(
          `INSERT INTO throwbox_state (id, game_objects, transfer_history, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id) DO UPDATE SET
             game_objects = EXCLUDED.game_objects,
             transfer_history = EXCLUDED.transfer_history,
             updated_at = EXCLUDED.updated_at`,
          [
            STATE_ROW_ID,
            JSON.stringify(persistedObjects),
            JSON.stringify(globalRoom.transferHistory.slice(0, 50))
          ]
        );
        console.log("Persisted state to Postgres");
      } catch (err) {
        console.error("Postgres persist failed:", err);
      }
    }, 1e3);
  }
  await loadPersistedState();
  const socketRoomMap = /* @__PURE__ */ new Map();
  function joinRoom(socket, targetRoomCode) {
    const prevRoomCode = socketRoomMap.get(socket.id);
    if (prevRoomCode) {
      const prevRoom = rooms.get(prevRoomCode);
      if (prevRoom) {
        prevRoom.users = prevRoom.users.filter((u) => u.id !== socket.id);
        prevRoom.gameObjects.forEach((obj) => {
          if (obj.holderId === socket.id) {
            obj.holderId = prevRoom.users.length > 0 ? prevRoom.users[0].id : null;
          }
        });
        socket.leave(prevRoomCode);
        io.to(prevRoomCode).emit("state-update", {
          users: prevRoom.users,
          gameObjects: prevRoom.gameObjects,
          transferHistory: prevRoom.transferHistory
        });
        if (prevRoomCode !== "global" && prevRoom.users.length === 0) {
          rooms.delete(prevRoomCode);
          console.log(`Cleaned up empty room: ${prevRoomCode}`);
        }
      }
    }
    let room = rooms.get(targetRoomCode);
    if (!room) {
      room = {
        code: targetRoomCode,
        users: [],
        gameObjects: DEFAULT_OBJECTS.map((obj) => ({
          ...obj,
          id: `${obj.id}_${Math.random().toString(36).substring(2, 6)}`
        })),
        transferHistory: []
      };
      rooms.set(targetRoomCode, room);
      console.log(`Created new private room: ${targetRoomCode}`);
    }
    if (room.users.length >= MAX_USERS) {
      socket.emit("room-full");
      return false;
    }
    let newGridX = -1;
    let newGridY = -1;
    for (const pos of CROSS_POSITIONS) {
      if (!room.users.some((u) => u.gridX === pos.x && u.gridY === pos.y)) {
        newGridX = pos.x;
        newGridY = pos.y;
        break;
      }
    }
    let newPlayerNumber = 1;
    while (room.users.some((u) => u.playerNumber === newPlayerNumber)) {
      newPlayerNumber++;
    }
    const newUser = {
      id: socket.id,
      position: newGridY * GRID_SIZE + newGridX,
      playerNumber: newPlayerNumber,
      gridX: newGridX,
      gridY: newGridY
    };
    room.users.push(newUser);
    socketRoomMap.set(socket.id, targetRoomCode);
    socket.join(targetRoomCode);
    if (room.users.length === 1) {
      room.gameObjects.forEach((obj) => {
        if (!obj.holderId) obj.holderId = socket.id;
      });
    }
    console.log(`User ${socket.id} joined room ${targetRoomCode}`);
    io.to(targetRoomCode).emit("state-update", {
      users: room.users,
      gameObjects: room.gameObjects,
      transferHistory: room.transferHistory
    });
    if (targetRoomCode === "global") {
      schedulePersist();
    }
    return true;
  }
  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);
    joinRoom(socket, "global");
    socket.on("join-room", (data) => {
      const targetRoom = data.roomCode?.trim().toUpperCase();
      if (!targetRoom) return;
      joinRoom(socket, targetRoom);
    });
    socket.on("transfer-object", (data) => {
      const roomCode = socketRoomMap.get(socket.id);
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (!room) return;
      const userIndex = room.users.findIndex((u) => u.id === socket.id);
      if (userIndex === -1) return;
      const objParams = room.gameObjects.find((o) => o.id === data.objectId);
      if (!objParams || objParams.holderId !== socket.id) return;
      const senderUser = room.users[userIndex];
      let targetUser = null;
      if (room.users.length > 1) {
        let targetX = senderUser.gridX;
        let targetY = senderUser.gridY;
        for (let i = 1; i < GRID_SIZE; i++) {
          if (data.direction === "right") targetX = (targetX + 1) % GRID_SIZE;
          else if (data.direction === "left") targetX = (targetX - 1 + GRID_SIZE) % GRID_SIZE;
          else if (data.direction === "down") targetY = (targetY + 1) % GRID_SIZE;
          else if (data.direction === "up") targetY = (targetY - 1 + GRID_SIZE) % GRID_SIZE;
          targetUser = room.users.find((u) => u.gridX === targetX && u.gridY === targetY);
          if (targetUser) break;
        }
        if (!targetUser) {
          targetUser = room.users.find((u) => u.id !== socket.id);
        }
      }
      if (targetUser) {
        objParams.holderId = targetUser.id;
        const timestamp = Date.now();
        const record = {
          id: Math.random().toString(36).substring(2, 9),
          senderId: senderUser.id,
          senderPosition: senderUser.playerNumber,
          receiverId: targetUser.id,
          receiverPosition: targetUser.playerNumber,
          objectName: objParams.name,
          timestamp
        };
        room.transferHistory.unshift(record);
        if (room.transferHistory.length > 50) room.transferHistory.pop();
        io.to(roomCode).emit("object-transferred", {
          senderId: senderUser.id,
          newHolderId: targetUser.id,
          direction: data.direction,
          record,
          objectId: objParams.id
        });
        io.to(roomCode).emit("state-update", {
          users: room.users,
          gameObjects: room.gameObjects,
          transferHistory: room.transferHistory
        });
        if (roomCode === "global") {
          schedulePersist();
        }
      }
    });
    socket.on("create-drawing", (data) => {
      const roomCode = socketRoomMap.get(socket.id);
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (!room) return;
      const newObj = {
        id: `obj_${data.shape || "draw"}_${Math.random().toString(36).substring(2, 9)}`,
        name: data.name || `OBJECT_${Math.floor(Math.random() * 1e3)}`,
        category: data.drawingData ? "USER_ART" : "GEOMETRY",
        shape: data.shape || "plane",
        color: data.color || "#FFFFFF",
        holderId: socket.id,
        drawingData: data.drawingData
      };
      room.gameObjects.push(newObj);
      io.to(roomCode).emit("state-update", {
        users: room.users,
        gameObjects: room.gameObjects,
        transferHistory: room.transferHistory
      });
      if (roomCode === "global") {
        schedulePersist();
      }
    });
    socket.on("dragging-object", (data) => {
      const roomCode = socketRoomMap.get(socket.id);
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (!room) return;
      const senderUser = room.users.find((u) => u.id === socket.id);
      if (!senderUser) return;
      let targetUser = null;
      if (room.users.length > 1) {
        let targetX = senderUser.gridX;
        let targetY = senderUser.gridY;
        for (let i = 1; i < GRID_SIZE; i++) {
          if (data.direction === "right") targetX = (targetX + 1) % GRID_SIZE;
          else if (data.direction === "left") targetX = (targetX - 1 + GRID_SIZE) % GRID_SIZE;
          else if (data.direction === "down") targetY = (targetY + 1) % GRID_SIZE;
          else if (data.direction === "up") targetY = (targetY - 1 + GRID_SIZE) % GRID_SIZE;
          targetUser = room.users.find((u) => u.gridX === targetX && u.gridY === targetY);
          if (targetUser) break;
        }
      }
      if (targetUser && targetUser.id !== socket.id) {
        io.to(targetUser.id).emit("peer-dragging", {
          objectId: data.objectId,
          senderLeft: data.senderLeft,
          senderTop: data.senderTop,
          senderWidth: data.senderWidth,
          senderHeight: data.senderHeight,
          direction: data.direction,
          senderPosition: senderUser.playerNumber,
          senderId: socket.id
        });
      }
    });
    socket.on("reset-state", () => {
      const roomCode = socketRoomMap.get(socket.id);
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (!room) return;
      if (room.users.length > 0) {
        room.gameObjects.forEach((obj) => obj.holderId = room.users[0].id);
        room.transferHistory = [];
        io.to(roomCode).emit("state-update", {
          users: room.users,
          gameObjects: room.gameObjects,
          transferHistory: room.transferHistory
        });
        if (roomCode === "global") {
          schedulePersist();
        }
      }
    });
    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      const roomCode = socketRoomMap.get(socket.id);
      if (roomCode) {
        const room = rooms.get(roomCode);
        if (room) {
          room.users = room.users.filter((u) => u.id !== socket.id);
          room.gameObjects.forEach((obj) => {
            if (obj.holderId === socket.id) {
              obj.holderId = room.users.length > 0 ? room.users[0].id : null;
            }
          });
          io.to(roomCode).emit("state-update", {
            users: room.users,
            gameObjects: room.gameObjects,
            transferHistory: room.transferHistory
          });
          if (roomCode === "global") {
            schedulePersist();
          } else if (room.users.length === 0) {
            rooms.delete(roomCode);
            console.log(`Cleaned up empty room: ${roomCode}`);
          }
        }
        socketRoomMap.delete(socket.id);
      }
    });
  });
  app.get("/api/config", (req, res) => {
    res.json({
      primaryColor: process.env.PRIMARY_COLOR || "#00F0FF",
      primaryColorDark: process.env.PRIMARY_COLOR_DARK || "#00D0DF"
    });
  });
  app.get("/api/version", (req, res) => {
    res.json({
      version: process.env.LATEST_APP_VERSION || "1.0.0",
      apkUrl: process.env.APK_DOWNLOAD_URL || "https://github.com/GilbertoMF/throwbox-app/releases"
    });
  });
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });
  app.post("/api/auth/register", async (req, res) => {
    if (!pool) return res.status(500).json({ error: "No database pool" });
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });
    try {
      const emailLower = email.toLowerCase().trim();
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = crypto.pbkdf2Sync(password, salt, 1e3, 64, "sha512").toString("hex");
      const id = crypto.randomUUID();
      await pool.query(
        "INSERT INTO throwbox_users (id, email, password_hash, password_salt) VALUES ($1, $2, $3, $4)",
        [id, emailLower, hash, salt]
      );
      const sessionToken = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1e3);
      await pool.query(
        "INSERT INTO throwbox_sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
        [sessionToken, id, expiresAt]
      );
      res.json({ token: sessionToken, user: { id, email: emailLower } });
    } catch (err) {
      if (err.code === "23505") {
        return res.status(400).json({ error: "Email j\xE1 cadastrado" });
      }
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/auth/login", async (req, res) => {
    if (!pool) return res.status(500).json({ error: "No database pool" });
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });
    try {
      const emailLower = email.toLowerCase().trim();
      const { rows } = await pool.query(
        "SELECT id, password_hash, password_salt FROM throwbox_users WHERE email = $1",
        [emailLower]
      );
      if (rows.length === 0) return res.status(400).json({ error: "Usu\xE1rio ou senha incorretos" });
      const user = rows[0];
      const checkHash = crypto.pbkdf2Sync(password, user.password_salt, 1e3, 64, "sha512").toString("hex");
      if (checkHash !== user.password_hash) {
        return res.status(400).json({ error: "Usu\xE1rio ou senha incorretos" });
      }
      const sessionToken = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1e3);
      await pool.query(
        "INSERT INTO throwbox_sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
        [sessionToken, user.id, expiresAt]
      );
      res.json({ token: sessionToken, user: { id: user.id, email: emailLower } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get("/api/auth/me", async (req, res) => {
    if (!pool) return res.status(500).json({ error: "No database pool" });
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token" });
    }
    const token = authHeader.split(" ")[1];
    try {
      const { rows } = await pool.query(
        `SELECT u.id, u.email, (t.google_refresh_token IS NOT NULL) as is_drive_linked 
         FROM throwbox_sessions s
         JOIN throwbox_users u ON s.user_id = u.id
         LEFT JOIN throwbox_user_tokens t ON u.id = t.user_id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token]
      );
      if (rows.length === 0) return res.status(401).json({ error: "Invalid session" });
      res.json({ user: rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/auth/google/token", async (req, res) => {
    if (!pool) return res.status(500).json({ error: "No database pool" });
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token" });
    }
    const token = authHeader.split(" ")[1];
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Missing authorization code" });
    try {
      const sessionRes = await pool.query(
        "SELECT user_id FROM throwbox_sessions WHERE token = $1 AND expires_at > NOW()",
        [token]
      );
      if (sessionRes.rows.length === 0) return res.status(401).json({ error: "Invalid session" });
      const userId = sessionRes.rows[0].user_id;
      const client_id = process.env.GOOGLE_CLIENT_ID || "";
      const client_secret = process.env.GOOGLE_CLIENT_SECRET || "";
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id,
          client_secret,
          redirect_uri: "postmessage",
          grant_type: "authorization_code"
        }).toString()
      });
      const data = await response.json();
      if (!response.ok || !data.refresh_token) {
        return res.status(400).json({
          error: "Falha ao obter refresh_token do Google. Tente desvincular o app da sua conta Google e vincular novamente.",
          details: data
        });
      }
      await pool.query(
        `INSERT INTO throwbox_user_tokens (user_id, google_refresh_token, updated_at) 
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET 
           google_refresh_token = EXCLUDED.google_refresh_token,
           updated_at = EXCLUDED.updated_at`,
        [userId, data.refresh_token]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/drive/save", async (req, res) => {
    if (!pool) return res.status(500).json({ error: "No database pool" });
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token" });
    }
    const token = authHeader.split(" ")[1];
    const { objectName, drawingData } = req.body;
    if (!objectName || !drawingData) return res.status(400).json({ error: "Missing parameters" });
    try {
      const userRes = await pool.query(
        `SELECT u.id, t.google_refresh_token 
         FROM throwbox_sessions s
         JOIN throwbox_users u ON s.user_id = u.id
         JOIN throwbox_user_tokens t ON u.id = t.user_id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token]
      );
      if (userRes.rows.length === 0) {
        return res.status(401).json({ error: "Sua conta do Google Drive n\xE3o est\xE1 vinculada." });
      }
      const refreshToken = userRes.rows[0].google_refresh_token;
      const client_id = process.env.GOOGLE_CLIENT_ID || "";
      const client_secret = process.env.GOOGLE_CLIENT_SECRET || "";
      const refreshResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id,
          client_secret,
          refresh_token: refreshToken,
          grant_type: "refresh_token"
        }).toString()
      });
      const refreshData = await refreshResponse.json();
      if (!refreshResponse.ok || !refreshData.access_token) {
        return res.status(400).json({ error: "Falha ao renovar acesso do Google Drive", details: refreshData });
      }
      const accessToken = refreshData.access_token;
      const searchResponse = await fetch(
        "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent("name='ThrowBox' and mimeType='application/vnd.google-apps.folder' and trashed=false"),
        {
          headers: { "Authorization": `Bearer ${accessToken}` }
        }
      );
      const searchData = await searchResponse.json();
      let folderId = "";
      if (searchData.files && searchData.files.length > 0) {
        folderId = searchData.files[0].id;
      } else {
        const createFolderRes = await fetch("https://www.googleapis.com/drive/v3/files", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name: "ThrowBox",
            mimeType: "application/vnd.google-apps.folder"
          })
        });
        const createFolderData = await createFolderRes.json();
        if (!createFolderRes.ok) {
          return res.status(400).json({ error: "Falha ao criar pasta ThrowBox no Google Drive", details: createFolderData });
        }
        folderId = createFolderData.id;
      }
      const base64Clean = drawingData.replace(/^data:image\/png;base64,/, "");
      const buffer = Buffer.from(base64Clean, "base64");
      const boundary = "throwbox_multipart_boundary";
      const metadata = JSON.stringify({
        name: `${objectName.toLowerCase()}_${Date.now()}.png`,
        parents: [folderId]
      });
      const multipartBody = Buffer.concat([
        Buffer.from(`--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${metadata}\r
`),
        Buffer.from(`--${boundary}\r
Content-Type: image/png\r
\r
`),
        buffer,
        Buffer.from(`\r
--${boundary}--`)
      ]);
      const uploadRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) {
        return res.status(400).json({ error: "Falha ao carregar arquivo no Google Drive", details: uploadData });
      }
      res.json({ success: true, fileId: uploadData.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}
startServer();
