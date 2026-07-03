import express from "express";
import { createServer as createViteServer } from "vite";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import pkg from "pg";
const { Pool } = pkg;

async function startServer() {
  const app = express();

  // Allow CORS for all API endpoints (necessary for Android webview fetch requests)
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

  interface Room {
    code: string;
    users: User[];
    gameObjects: GameObject[];
    transferHistory: TransferRecord[];
  }

  const rooms = new Map<string, Room>();

  const DEFAULT_OBJECTS: GameObject[] = [
    { id: "obj_tesseract", name: "TESSERACT", category: "ARTIFACT", shape: "box", color: "#00F0FF", holderId: null },
    { id: "obj_astral_sphere", name: "ASTRAL_SPHERE", category: "GEOMETRY", shape: "sphere", color: "#FF00FF", holderId: null },
    { id: "obj_prism_core", name: "PRISM_CORE", category: "ARTIFACT", shape: "octahedron", color: "#00FF00", holderId: null },
    { id: "obj_data_cube", name: "DATA_CUBE", category: "GEOMETRY", shape: "box", color: "#FFFF00", holderId: null },
    { id: "obj_void_orb", name: "VOID_ORB", category: "UNKNOWN", shape: "sphere", color: "#FF0000", holderId: null }
  ];

  // Initialize global room
  rooms.set("global", {
    code: "global",
    users: [],
    gameObjects: [...DEFAULT_OBJECTS],
    transferHistory: []
  });

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

      const globalRoom = rooms.get("global")!;
      if (rows.length > 0) {
        const data = rows[0];
        if (Array.isArray(data.game_objects) && data.game_objects.length > 0) {
          globalRoom.gameObjects = data.game_objects.map((obj: any) => ({ ...obj, holderId: null }));
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
      const globalRoom = rooms.get("global")!;
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
    }, 1000);
  }

  await loadPersistedState();

  const socketRoomMap = new Map<string, string>(); // socket.id -> roomCode

  function joinRoom(socket: any, targetRoomCode: string) {
    const prevRoomCode = socketRoomMap.get(socket.id);
    
    // 1. Remove from previous room if any
    if (prevRoomCode) {
      const prevRoom = rooms.get(prevRoomCode);
      if (prevRoom) {
        prevRoom.users = prevRoom.users.filter(u => u.id !== socket.id);
        
        // Re-assign objects held by the leaving user to the first remaining user
        prevRoom.gameObjects.forEach(obj => {
          if (obj.holderId === socket.id) {
            obj.holderId = prevRoom.users.length > 0 ? prevRoom.users[0].id : null;
          }
        });

        socket.leave(prevRoomCode);
        
        // Notify remaining users in previous room
        io.to(prevRoomCode).emit("state-update", {
          users: prevRoom.users,
          gameObjects: prevRoom.gameObjects,
          transferHistory: prevRoom.transferHistory
        });

        // Clean up empty private rooms
        if (prevRoomCode !== "global" && prevRoom.users.length === 0) {
          rooms.delete(prevRoomCode);
          console.log(`Cleaned up empty room: ${prevRoomCode}`);
        }
      }
    }

    // 2. Initialize target room if it doesn't exist (only private rooms)
    let room = rooms.get(targetRoomCode);
    if (!room) {
      room = {
        code: targetRoomCode,
        users: [],
        gameObjects: DEFAULT_OBJECTS.map(obj => ({ 
          ...obj, 
          id: `${obj.id}_${Math.random().toString(36).substring(2, 6)}` 
        })),
        transferHistory: []
      };
      rooms.set(targetRoomCode, room);
      console.log(`Created new private room: ${targetRoomCode}`);
    }

    // Check if room is full
    if (room.users.length >= MAX_USERS) {
      socket.emit("room-full");
      return false;
    }

    // 3. Find first available preset cross position in the new room
    let newGridX = -1;
    let newGridY = -1;
    for (const pos of CROSS_POSITIONS) {
      if (!room.users.some(u => u.gridX === pos.x && u.gridY === pos.y)) {
        newGridX = pos.x;
        newGridY = pos.y;
        break;
      }
    }

    let newPlayerNumber = 1;
    while (room.users.some(u => u.playerNumber === newPlayerNumber)) {
      newPlayerNumber++;
    }

    const newUser: User = { 
      id: socket.id, 
      position: newGridY * GRID_SIZE + newGridX,
      playerNumber: newPlayerNumber,
      gridX: newGridX,
      gridY: newGridY
    };
    room.users.push(newUser);
    socketRoomMap.set(socket.id, targetRoomCode);
    socket.join(targetRoomCode);

    // If first user, assign unassigned objects to them
    if (room.users.length === 1) {
      room.gameObjects.forEach(obj => {
        if (!obj.holderId) obj.holderId = socket.id;
      });
    }

    console.log(`User ${socket.id} joined room ${targetRoomCode}`);

    // Send state-update to the target room
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
    
    // Automatically join the global room on connection (supports legacy clients)
    joinRoom(socket, "global");

    socket.on("join-room", (data: { roomCode: string }) => {
      const targetRoom = data.roomCode?.trim().toUpperCase();
      if (!targetRoom) return;
      joinRoom(socket, targetRoom);
    });

    socket.on("transfer-object", (data: { objectId: string, direction: "left" | "right" | "up" | "down" }) => {
      const roomCode = socketRoomMap.get(socket.id);
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (!room) return;

      const userIndex = room.users.findIndex(u => u.id === socket.id);
      if (userIndex === -1) return;
      
      const objParams = room.gameObjects.find(o => o.id === data.objectId);
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

          targetUser = room.users.find(u => u.gridX === targetX && u.gridY === targetY);
          if (targetUser) break;
        }

        if (!targetUser) {
          targetUser = room.users.find(u => u.id !== socket.id);
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

    socket.on("create-drawing", (data: { drawingData?: string, color: string, shape?: 'box' | 'sphere' | 'octahedron' | 'plane', name?: string }) => {
      const roomCode = socketRoomMap.get(socket.id);
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (!room) return;

      const newObj: GameObject = {
        id: `obj_${data.shape || 'draw'}_${Math.random().toString(36).substring(2, 9)}`,
        name: data.name || `OBJECT_${Math.floor(Math.random() * 1000)}`,
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

    socket.on("dragging-object", (data: { objectId: string, senderLeft: number, senderTop: number, senderWidth: number, senderHeight: number, direction: 'left' | 'right' | 'up' | 'down', senderId: string }) => {
      const roomCode = socketRoomMap.get(socket.id);
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (!room) return;

      const senderUser = room.users.find(u => u.id === socket.id);
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

          targetUser = room.users.find(u => u.gridX === targetX && u.gridY === targetY);
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
        room.gameObjects.forEach(obj => obj.holderId = room.users[0].id);
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
          room.users = room.users.filter(u => u.id !== socket.id);
          
          // Re-assign object ownership
          room.gameObjects.forEach(obj => {
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
