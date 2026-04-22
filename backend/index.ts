import express from "express";
import { createServer as createViteServer } from "vite";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import pkg from "pg";
const { Pool } = pkg;

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
    maxHttpBufferSize: 1e7, // 10MB to handle large drawing dataURLs
  });

  const PORT = Number(process.env.PORT) || 3000;

  interface User {
    id: string;
    position: number;
    playerNumber: number;
    gridX: number;
    gridY: number;
  }
  
  interface GameObject {
    id: string;
    name: string;
    category: string;
    shape: 'box' | 'sphere' | 'octahedron' | 'plane';
    color: string;
    holderId: string | null;
    drawingData?: string;
  }

  interface TransferRecord {
    id: string;
    senderId: string;
    senderPosition: number;
    receiverId: string;
    receiverPosition: number;
    objectName: string;
    timestamp: number;
  }

  // Database setup (Postgres via PG instead of Supabase SDK)
  const pool = process.env.DATABASE_URL 
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : null;

  const STATE_ROW_ID = "global";
  let persistTimer: NodeJS.Timeout | null = null;

  let users: User[] = [];
  const MAX_USERS = 5;
  const GRID_SIZE = 3;
  
  // Cross layout: 1 center, 4 directions
  const CROSS_POSITIONS = [
    { x: 1, y: 1 }, // Center
    { x: 1, y: 0 }, // Up
    { x: 2, y: 1 }, // Right
    { x: 1, y: 2 }, // Down
    { x: 0, y: 1 }, // Left
  ];
  
  let gameObjects: GameObject[] = [
    { id: "obj_tesseract", name: "TESSERACT", category: "ARTIFACT", shape: "box", color: "#00F0FF", holderId: null },
    { id: "obj_astral_sphere", name: "ASTRAL_SPHERE", category: "GEOMETRY", shape: "sphere", color: "#FF00FF", holderId: null },
    { id: "obj_prism_core", name: "PRISM_CORE", category: "ARTIFACT", shape: "octahedron", color: "#00FF00", holderId: null },
    { id: "obj_data_cube", name: "DATA_CUBE", category: "GEOMETRY", shape: "box", color: "#FFFF00", holderId: null },
    { id: "obj_void_orb", name: "VOID_ORB", category: "UNKNOWN", shape: "sphere", color: "#FF0000", holderId: null }
  ];

  let transferHistory: TransferRecord[] = [];

  async function loadPersistedState() {
    if (!pool) return;

    try {
      // Auto-create table if it doesn't exist
      await pool.query(`
        CREATE TABLE IF NOT EXISTS throwbox_state (
          id TEXT PRIMARY KEY,
          game_objects JSONB NOT NULL DEFAULT '[]',
          transfer_history JSONB NOT NULL DEFAULT '[]',
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      const { rows } = await pool.query(
        "SELECT game_objects, transfer_history FROM throwbox_state WHERE id = $1",
        [STATE_ROW_ID]
      );

      if (rows.length > 0) {
        const data = rows[0];
        if (Array.isArray(data.game_objects) && data.game_objects.length > 0) {
          gameObjects = data.game_objects.map((obj: any) => ({ ...obj, holderId: null }));
        }
        if (Array.isArray(data.transfer_history)) {
          transferHistory = data.transfer_history.slice(0, 50);
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
      const persistedObjects = gameObjects.map((obj) => ({ ...obj, holderId: null }));

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
            JSON.stringify(transferHistory.slice(0, 50))
          ]
        );
      } catch (err) {
        console.error("Postgres save failed:", err);
      }
    }, 1000);
  }

  await loadPersistedState();

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);
    
    if (users.length >= MAX_USERS) {
      socket.emit("room-full");
      return;
    }

    // Find first available preset cross position
    let newGridX = -1;
    let newGridY = -1;
    for (const pos of CROSS_POSITIONS) {
      if (!users.some(u => u.gridX === pos.x && u.gridY === pos.y)) {
        newGridX = pos.x;
        newGridY = pos.y;
        break;
      }
    }

    let newPlayerNumber = 1;
    while (users.some(u => u.playerNumber === newPlayerNumber)) {
      newPlayerNumber++;
    }

    const newUser: User = { 
      id: socket.id, 
      position: newGridY * GRID_SIZE + newGridX,
      playerNumber: newPlayerNumber,
      gridX: newGridX,
      gridY: newGridY
    };
    users.push(newUser);

    if (users.length === 1) {
      gameObjects.forEach(obj => {
        if (!obj.holderId) obj.holderId = socket.id;
      });
    }

    io.emit("state-update", { users, gameObjects, transferHistory });

    socket.on("transfer-object", (data: { objectId: string, direction: "left" | "right" | "up" | "down" }) => {
      const userIndex = users.findIndex(u => u.id === socket.id);
      if (userIndex === -1) return;
      
      const objParams = gameObjects.find(o => o.id === data.objectId);
      if (!objParams || objParams.holderId !== socket.id) return;

      const senderUser = users[userIndex];
      let targetUser = null;

      if (users.length > 1) {
        let targetX = senderUser.gridX;
        let targetY = senderUser.gridY;

        for (let i = 1; i < GRID_SIZE; i++) {
          if (data.direction === "right") targetX = (targetX + 1) % GRID_SIZE;
          else if (data.direction === "left") targetX = (targetX - 1 + GRID_SIZE) % GRID_SIZE;
          else if (data.direction === "down") targetY = (targetY + 1) % GRID_SIZE;
          else if (data.direction === "up") targetY = (targetY - 1 + GRID_SIZE) % GRID_SIZE;

          targetUser = users.find(u => u.gridX === targetX && u.gridY === targetY);
          if (targetUser) break;
        }

        if (!targetUser) {
          targetUser = users.find(u => u.id !== socket.id);
        }
      }

      if (targetUser) {
        objParams.holderId = targetUser.id;
        
        const timestamp = Date.now();
        const record: TransferRecord = {
          id: Math.random().toString(36).substring(2, 9),
          senderId: senderUser.id,
          senderPosition: senderUser.playerNumber,
          receiverId: targetUser.id,
          receiverPosition: targetUser.playerNumber,
          objectName: objParams.name,
          timestamp
        };
        transferHistory.unshift(record);
        if (transferHistory.length > 50) transferHistory.pop();

        io.emit("object-transferred", {
          senderId: senderUser.id,
          newHolderId: targetUser.id,
          direction: data.direction,
          record,
          objectId: objParams.id
        });
        io.emit("state-update", { users, gameObjects, transferHistory });
        schedulePersist();
      }
    });

    socket.on("create-drawing", (data: { drawingData?: string, color: string, shape?: 'box' | 'sphere' | 'octahedron' | 'plane', name?: string }) => {
      const newObj: GameObject = {
        id: `obj_${data.shape || 'draw'}_${Math.random().toString(36).substring(2, 9)}`,
        name: data.name || `OBJECT_${Math.floor(Math.random() * 1000)}`,
        category: data.drawingData ? "USER_ART" : "GEOMETRY",
        shape: data.shape || "plane",
        color: data.color || "#FFFFFF",
        holderId: socket.id,
        drawingData: data.drawingData
      };
      gameObjects.push(newObj);
      io.emit("state-update", { users, gameObjects, transferHistory });
      schedulePersist();
    });

    socket.on("dragging-object", (data: { objectId: string, senderLeft: number, senderTop: number, senderWidth: number, senderHeight: number, direction: 'left' | 'right' | 'up' | 'down', senderId: string }) => {
      const senderUser = users.find(u => u.id === socket.id);
      if (!senderUser) return;
      
      let targetUser = null;
      if (users.length > 1) {
        let targetX = senderUser.gridX;
        let targetY = senderUser.gridY;

        for (let i = 1; i < GRID_SIZE; i++) {
          if (data.direction === "right") targetX = (targetX + 1) % GRID_SIZE;
          else if (data.direction === "left") targetX = (targetX - 1 + GRID_SIZE) % GRID_SIZE;
          else if (data.direction === "down") targetY = (targetY + 1) % GRID_SIZE;
          else if (data.direction === "up") targetY = (targetY - 1 + GRID_SIZE) % GRID_SIZE;

          targetUser = users.find(u => u.gridX === targetX && u.gridY === targetY);
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
       if (users.length > 0) {
         gameObjects.forEach(obj => obj.holderId = users[0].id);
         transferHistory = [];
         io.emit("state-update", { users, gameObjects, transferHistory });
         schedulePersist();
       }
    });

    socket.on("disconnect", () => {
      const index = users.findIndex(u => u.id === socket.id);
      if (index !== -1) {
        users.splice(index, 1);
        users.forEach((u, i) => u.position = i);

        gameObjects.forEach(obj => {
          if (obj.holderId === socket.id) {
            obj.holderId = users.length > 0 ? users[0].id : null;
          }
        });

        io.emit("state-update", { users, gameObjects, transferHistory });
      }
    });
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Correct paths for serving from dist when server is in backend/ and run from root
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
