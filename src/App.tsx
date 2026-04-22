import React, { useEffect, useState, useRef } from 'react';
import { motion, useAnimation, AnimatePresence } from 'motion/react';
import { io, Socket } from 'socket.io-client';
import { MonitorSmartphone, Users, History, X, Package, PenTool, Octagon, Box, Circle, Triangle, Image as ImageIcon, Sparkles } from 'lucide-react';

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

function ObjectIcon({ obj, size = 120, opacity = 1 }: { obj: GameObject, size?: number, opacity?: number }) {
  if (obj.shape === 'plane' && obj.drawingData) {
    return (
      <div className="relative flex items-center justify-center overflow-hidden rounded-lg border border-[#00F0FF]/30 bg-black/40" style={{ width: size, height: size }}>
        <img 
          src={obj.drawingData} 
          alt={obj.name} 
          className="max-w-full max-h-full object-contain"
          referrerPolicy="no-referrer"
          style={{ opacity }}
        />
        <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_20px_rgba(0,240,255,0.2)]" />
      </div>
    );
  }

  const iconProps = { 
    size, 
    color: obj.color, 
    strokeWidth: 1.5,
    style: { opacity, filter: `drop-shadow(0 0 10px ${obj.color}50)` }
  };

  return (
    <div className="flex items-center justify-center animate-pulse-slow">
       {obj.shape === 'box' && <Box {...iconProps} />}
       {obj.shape === 'sphere' && <Circle {...iconProps} />}
       {obj.shape === 'octahedron' && <Octagon {...iconProps} />}
       {obj.shape === 'plane' && !obj.drawingData && <ImageIcon {...iconProps} />}
    </div>
  );
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [gameObjects, setGameObjects] = useState<GameObject[]>([]);
  const [transferHistory, setTransferHistory] = useState<TransferRecord[]>([]);
  const [myId, setMyId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string>('Connecting...');
  const [incomingDirection, setIncomingDirection] = useState<'left' | 'right' | 'up' | 'down' | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showInventory, setShowInventory] = useState(false);
  const [notification, setNotification] = useState<{message: string, id: number} | null>(null);
  const [stagedObjectId, setStagedObjectId] = useState<string | null>(null);
  const [showCanvas, setShowCanvas] = useState(false);
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [selectedColor, setSelectedColor] = useState('#00F0FF');
  const [brushSize, setBrushSize] = useState(1);
  const [selectedCreationMode, setSelectedCreationMode] = useState<'doodle' | 'shape'>('doodle');
  const [selectedShape, setSelectedShape] = useState<'box' | 'sphere' | 'octahedron'>('box');
  const colors = ['#00F0FF', '#FF00FF', '#00FF00', '#FFFF00', '#FF4444', '#FFFFFF'];
  const shapeTypes = [
    { id: 'box', name: 'Cube', icon: Box },
    { id: 'sphere', name: 'Sphere', icon: Circle },
    { id: 'octahedron', name: 'Prism', icon: Triangle }
  ];

  // Real-time drag sync state
  const [peerDrag, setPeerDrag] = useState<{
    objectId: string;
    senderLeft: number;
    senderTop: number;
    senderWidth: number;
    senderHeight: number;
    direction: 'left' | 'right' | 'up' | 'down';
    senderPosition: number;
    senderId: string;
  } | null>(null);

  const controls = useAnimation();
  const containerRef = useRef<HTMLDivElement>(null);

  const myObjects = gameObjects.filter(obj => obj.holderId === myId);
  const stagedObject = gameObjects.find(obj => obj.id === stagedObjectId && obj.holderId === myId);
  const socketUrl =
    import.meta.env.VITE_SOCKET_URL?.trim() ||
    (window.location.protocol === 'capacitor:' ? 'http://10.0.2.2:3000' : '');

  // Better staging logic: Only pick a default if we have literally nothing selected
  useEffect(() => {
    // If we lose our staged object (it was transferred away or deleted)
    if (stagedObjectId && !myObjects.some(o => o.id === stagedObjectId)) {
      // Don't clear immediately if we just received something (handled by incomingDirection check)
      if (!incomingDirection) {
        setStagedObjectId(myObjects.length > 0 ? myObjects[0].id : null);
      }
    } 
    // If we have nothing staged but have items, pick the first one
    else if (!stagedObjectId && myObjects.length > 0) {
      setStagedObjectId(myObjects[0].id);
    }
  }, [myObjects, stagedObjectId, incomingDirection]);

  useEffect(() => {
    const newSocket = socketUrl ? io(socketUrl) : io();
    
    newSocket.on('connect', () => {
      setSocket(newSocket);
      setMyId(newSocket.id || null);
      setConnectionStatus('Connected');
    });

    newSocket.on('room-full', () => {
      setConnectionStatus('Room Full (Max 5)');
      newSocket.disconnect();
    });

    newSocket.on('disconnect', () => {
      setConnectionStatus('Disconnected');
    });

    newSocket.on('state-update', (state: { users: User[], gameObjects: GameObject[], transferHistory: TransferRecord[] }) => {
      setUsers(state.users);
      if (state.gameObjects) setGameObjects(state.gameObjects);
      if (state.transferHistory) setTransferHistory(state.transferHistory);
    });

    newSocket.on('object-transferred', (data: { senderId: string, newHolderId: string, direction: 'left' | 'right' | 'up' | 'down', record: TransferRecord, objectId: string }) => {
      setPeerDrag(null); // Clear any ghost objects on completion
      if (data.newHolderId === newSocket.id) {
        setIncomingDirection(data.direction);
        setStagedObjectId(data.objectId); // Auto-stage the received item
        const notifId = Date.now();
        setNotification({
          id: notifId,
          message: `INCOMING: ${data.record.objectName} FROM P-${data.record.senderPosition}`
        });
        setTimeout(() => setNotification(prev => prev?.id === notifId ? null : prev), 4000);
      } else if (data.senderId === newSocket.id) {
        const notifId = Date.now();
        setNotification({
          id: notifId,
          message: `SENT ${data.record.objectName} TO P-${data.record.receiverPosition}`
        });
        setTimeout(() => setNotification(prev => prev?.id === notifId ? null : prev), 4000);
      }
    });

    newSocket.on('peer-dragging', (data: any) => {
      setPeerDrag(data);
    });

    return () => {
      newSocket.disconnect();
    };
  }, [socketUrl]);

  // Portal visual feedback
  const [activePortal, setActivePortal] = useState<'left' | 'right' | 'up' | 'down' | null>(null);

  // Frame entrance animation for staged object
  useEffect(() => {
    if (stagedObject && incomingDirection) {
      let startX = 0;
      let startY = 0;
      let rotation = 0;
      
      if (incomingDirection === 'right') { startX = -window.innerWidth; rotation = -45; }
      if (incomingDirection === 'left') { startX = window.innerWidth; rotation = 45; }
      if (incomingDirection === 'down') { startY = -window.innerHeight; rotation = -45; }
      if (incomingDirection === 'up') { startY = window.innerHeight; rotation = 45; }
      
      // Flash the corresponding portal on arrival
      const portalMap: any = { 'right': 'left', 'left': 'right', 'down': 'up', 'up': 'down' };
      setActivePortal(portalMap[incomingDirection]);
      setTimeout(() => setActivePortal(null), 1000);

      const animateIn = async () => {
        await controls.set({ 
          x: startX, 
          y: startY, 
          scale: 0.8, 
          filter: 'blur(10px)',
          opacity: 0, 
          rotate: rotation 
        });
        
        controls.start({ 
          x: 0, 
          y: 0, 
          scale: 1, 
          opacity: 1, 
          rotate: 0, 
          filter: 'blur(0px)',
          transition: { 
            type: 'spring', 
            stiffness: 250, 
            damping: 25,
            mass: 0.8
          } 
        });
        setIncomingDirection(null);
      };
      setTimeout(animateIn, 100); // Slight delay for server sync perception
    } else if (stagedObject && !incomingDirection) {
       controls.set({ x: 0, y: 0, scale: 1, opacity: 1, filter: 'blur(0px)' });
    }
  }, [stagedObject?.id, incomingDirection, controls]);

  const lastDragDir = useRef<'left' | 'right' | 'up' | 'down'>('right');

  const handleDrag = (_: any, info: any) => {
    if (!socket || !stagedObject) return;
    
    // Absolute position of the touch/mouse relative to the viewport
    const pointerX = info.point.x;
    const pointerY = info.point.y;
    
    // Calculate the edges of the object (assuming it's 280px wide/tall and grabbed in the middle)
    const objectSize = 280;
    const halfSize = objectSize / 2;
    const senderLeft = pointerX - halfSize;
    const senderRight = pointerX + halfSize;
    const senderTop = pointerY - halfSize;
    const senderBottom = pointerY + halfSize;
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    
    const dragData = { 
      objectId: stagedObject.id, 
      senderLeft, 
      senderTop,
      senderWidth: screenWidth,
      senderHeight: screenHeight,
      senderId: socket.id 
    };

    // Check if any part of the object is crossing the boundaries
    if (senderRight > screenWidth) {
      lastDragDir.current = 'right';
      socket.emit('dragging-object', { ...dragData, direction: 'right' });
    } else if (senderLeft < 0) {
      lastDragDir.current = 'left';
      socket.emit('dragging-object', { ...dragData, direction: 'left' });
    } else if (senderBottom > screenHeight) {
      lastDragDir.current = 'down';
      socket.emit('dragging-object', { ...dragData, direction: 'down' });
    } else if (senderTop < 0) {
      lastDragDir.current = 'up';
      socket.emit('dragging-object', { ...dragData, direction: 'up' });
    } else {
      // Hide if dragging in the center
      socket.emit('dragging-object', { ...dragData, senderLeft: -9999, senderTop: -9999, direction: lastDragDir.current });
    }
  };

  const handleDragEnd = (event: any, info: any) => {
    if (!socket || !stagedObject) return;
    const x = info.offset.x;
    const y = info.offset.y;
    const threshold = 120;

    if (x > threshold) {
      setActivePortal('right');
      controls.start({ x: window.innerWidth * 0.8, y: 0, scale: 0.5, opacity: 0, rotate: 45, transition: { duration: 0.2 } }).then(() => {
        socket.emit('transfer-object', { objectId: stagedObject.id, direction: 'right' });
        setTimeout(() => setActivePortal(null), 500);
      });
    } else if (x < -threshold) {
      setActivePortal('left');
      controls.start({ x: -window.innerWidth * 0.8, y: 0, scale: 0.5, opacity: 0, rotate: -45, transition: { duration: 0.2 } }).then(() => {
        socket.emit('transfer-object', { objectId: stagedObject.id, direction: 'left' });
        setTimeout(() => setActivePortal(null), 500);
      });
    } else if (y > threshold) {
      setActivePortal('down');
      controls.start({ x: 0, y: window.innerHeight * 0.8, scale: 0.5, opacity: 0, rotate: 45, transition: { duration: 0.2 } }).then(() => {
        socket.emit('transfer-object', { objectId: stagedObject.id, direction: 'down' });
        setTimeout(() => setActivePortal(null), 500);
      });
    } else if (y < -threshold) {
      setActivePortal('up');
      controls.start({ x: 0, y: -window.innerHeight * 0.8, scale: 0.5, opacity: 0, rotate: -45, transition: { duration: 0.2 } }).then(() => {
        socket.emit('transfer-object', { objectId: stagedObject.id, direction: 'up' });
        setTimeout(() => setActivePortal(null), 500);
      });
    } else {
      controls.start({ x: 0, y: 0, transition: { type: 'spring', stiffness: 400, damping: 30 } });
    }
  };

  const myIndex = users.findIndex(u => u.id === myId);
  const me = myIndex !== -1 ? users[myIndex] : null;
  const GRID_SIZE = 3;
  
  // Neighbors identification (scan wrapping around to see who is next on each axis based on gridX/gridY)
  const getNeighbor = (dir: 'left'|'right'|'up'|'down') => {
    if (!me || users.length <= 1) return null;
    let targetX = me.gridX;
    let targetY = me.gridY;
    for (let i = 1; i < GRID_SIZE; i++) {
      if (dir === 'right') targetX = (targetX + 1) % GRID_SIZE;
      if (dir === 'left') targetX = (targetX - 1 + GRID_SIZE) % GRID_SIZE;
      if (dir === 'down') targetY = (targetY + 1) % GRID_SIZE;
      if (dir === 'up') targetY = (targetY - 1 + GRID_SIZE) % GRID_SIZE;
      const targetUser = users.find(u => u.gridX === targetX && u.gridY === targetY);
      if (targetUser) return targetUser;
    }
    return null; // Empty axis
  };

  const leftNeighbor = getNeighbor('left');
  const rightNeighbor = getNeighbor('right');
  const upNeighbor = getNeighbor('up');
  const downNeighbor = getNeighbor('down');

  // Group objects for inventory
  const inventoryByCategory: Record<string, GameObject[]> = {};
  myObjects.forEach(obj => {
    if (!inventoryByCategory[obj.category]) inventoryByCategory[obj.category] = [];
    inventoryByCategory[obj.category].push(obj);
  });

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = drawingCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let clientX, clientY;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    ctx.beginPath();
    ctx.moveTo(x, y);
    setIsDrawing(true);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = drawingCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let clientX, clientY;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    ctx.lineTo(x, y);
    ctx.strokeStyle = selectedColor;
    ctx.lineWidth = brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowBlur = brushSize * 2.5;
    ctx.shadowColor = selectedColor;
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    const canvas = drawingCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.closePath();
    setIsDrawing(false);
  };

  const handleCreate = () => {
    if (!socket) return;
    
    if (selectedCreationMode === 'doodle') {
      const canvas = drawingCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dataUrl = canvas.toDataURL('image/png');
      socket.emit('create-drawing', { drawingData: dataUrl, color: selectedColor, shape: 'plane', name: `DOODLE_${Math.floor(Math.random() * 1000)}` });
    } else {
      socket.emit('create-drawing', { 
        color: selectedColor, 
        shape: selectedShape, 
        name: `${selectedShape.toUpperCase()}_${Math.floor(Math.random() * 1000)}` 
      });
    }
    setShowCanvas(false);
  };

  const clearDrawing = () => {
    const canvas = drawingCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  };

  // Init canvas
  useEffect(() => {
    if (showCanvas) {
      clearDrawing();
    }
  }, [showCanvas]);

  return (
    <div className="min-h-[100dvh] bg-[#0A0A0A] text-white flex flex-col items-center justify-between p-4 sm:p-8 font-['Helvetica_Neue',Arial,sans-serif] overflow-hidden select-none relative z-0" ref={containerRef}>
      
      <div className="absolute inset-0 z-[-1] bg-[radial-gradient(circle_at_50%_50%,#1A1A1A_0%,#000000_100%)] pointer-events-none" />

      {/* Edge Portals */}
      <AnimatePresence>
        {activePortal === 'left' && (
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="absolute inset-y-0 left-0 w-2 bg-gradient-to-r from-[#00F0FF] to-transparent z-40 shadow-[10px_0_30px_#00F0FF50] blur-sm"
          />
        )}
        {activePortal === 'right' && (
          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="absolute inset-y-0 right-0 w-2 bg-gradient-to-l from-[#00F0FF] to-transparent z-40 shadow-[-10px_0_30px_#00F0FF50] blur-sm"
          />
        )}
      </AnimatePresence>

      {/* Header Panel */}
      <div className="w-full flex flex-col sm:flex-row justify-between items-center sm:items-start pt-2 sm:pt-4 z-20 gap-6 sm:gap-0">
        <div className="w-full sm:w-auto flex justify-between items-center">
          <div className="flex flex-col">
            <div className="font-bold text-[12px] sm:text-[14px] tracking-[4px] uppercase text-[#00F0FF]">
              {connectionStatus === 'Connected' ? 'ONLINE' : 'PROCURANDO DISPOSITIVOS'}
            </div>
            {me && (
              <div className="text-[10px] text-[#888] font-mono tracking-[1px] mt-1">
                MEU ID: P-{me.playerNumber}
              </div>
            )}
          </div>
          <div className="sm:hidden text-right">
            <div className="text-[9px] text-[#444] uppercase tracking-[1px]">REDE ATUAL</div>
            <div className="font-bold text-[11px]">{users.length} / 5 JOGADORES</div>
          </div>
        </div>
        
        <div className="w-full sm:w-auto flex justify-between sm:justify-end items-center gap-2 sm:gap-6">
          <button onClick={() => setShowCanvas(true)} className="flex flex-col items-center group cursor-pointer relative">
            <div className="text-[9px] sm:text-[11px] text-[#444] uppercase tracking-[1px] group-hover:text-white transition-colors">DOODLE</div>
            <div className="font-bold text-[11px] sm:text-base flex items-center gap-1"><PenTool className="w-3 h-3 sm:w-4 sm:h-4 text-[#00F0FF]" /> CREATE</div>
          </button>
          <button onClick={() => setShowInventory(true)} className="flex flex-col items-center group cursor-pointer relative">
            <div className="text-[9px] sm:text-[11px] text-[#444] uppercase tracking-[1px] group-hover:text-white transition-colors">ARMORY</div>
            <div className="font-bold text-[11px] sm:text-base flex items-center gap-1"><Package className="w-3 h-3 sm:w-4 sm:h-4 text-[#00F0FF]" /> INV<span className="hidden sm:inline">ENTORY</span></div>
            {myObjects.length > 0 && (
              <span className="absolute -top-1 -right-2 sm:-top-2 sm:-right-3 bg-[#00F0FF] text-black text-[9px] sm:text-[10px] font-black rounded-full w-4 h-4 sm:w-5 sm:h-5 flex items-center justify-center">
                {myObjects.length}
              </span>
            )}
          </button>
          <button onClick={() => setShowHistory(true)} className="flex flex-col items-center group cursor-pointer relative">
            <div className="text-[9px] sm:text-[11px] text-[#444] uppercase tracking-[1px] group-hover:text-white transition-colors">LOGS</div>
            <div className="font-bold text-[11px] sm:text-base flex items-center gap-1"><History className="w-3 h-3 sm:w-4 sm:h-4 text-[#00F0FF]" /> HIST<span className="hidden sm:inline">ORY</span></div>
          </button>
          <div className="hidden sm:block text-right ml-4">
            <div className="text-[11px] text-[#444] uppercase tracking-[1px]">REDE ATUAL</div>
            <div className="font-bold">{users.length} / 5 JOGADORES</div>
          </div>
        </div>
      </div>

      {/* Main Play Area */}
      <div className="flex-1 w-full flex items-center justify-center relative z-10">
        
        {/* Edge Indicators */}
        <div className="absolute inset-0 pointer-events-none flex flex-col justify-between items-center py-4 sm:py-8">
           <div className="flex flex-col items-center">
             {upNeighbor && <motion.div className="px-3 py-1 bg-[#00F0FF]/10 border border-[#00F0FF]/20 rounded-full mb-1"><div className="text-[9px] text-[#00F0FF] font-black tracking-[3px] uppercase">P-{upNeighbor.playerNumber}</div></motion.div>}
             {upNeighbor && <div className="text-[3vw] font-black uppercase tracking-[-1px] leading-[0.8] opacity-10">UP</div>}
           </div>
           <div className="flex flex-col items-center">
             {downNeighbor && <div className="text-[3vw] font-black uppercase tracking-[-1px] leading-[0.8] opacity-10">DOWN</div>}
             {downNeighbor && <motion.div className="px-3 py-1 bg-[#00F0FF]/10 border border-[#00F0FF]/20 rounded-full mt-1"><div className="text-[9px] text-[#00F0FF] font-black tracking-[3px] uppercase">P-{downNeighbor.playerNumber}</div></motion.div>}
           </div>
        </div>

        <div className="absolute inset-0 flex items-center justify-between pointer-events-none px-4 md:px-12">
           <div className="flex flex-col items-center gap-2">
             <div className="text-[5vw] font-black uppercase tracking-[-2px] leading-[0.8] opacity-10">LEFT</div>
             {leftNeighbor && (
               <motion.div 
                 initial={{ opacity: 0, y: 10 }}
                 animate={{ opacity: 1, y: 0 }}
                 className="px-3 py-1 bg-[#00F0FF]/10 border border-[#00F0FF]/20 rounded-full"
               >
                 <div className="text-[10px] text-[#00F0FF] font-black tracking-[3px] uppercase">P-{leftNeighbor.playerNumber}</div>
               </motion.div>
             )}
           </div>
           <div className="flex flex-col items-center gap-2">
             <div className="text-[5vw] font-black uppercase tracking-[-2px] leading-[0.8] opacity-10">RIGHT</div>
             {rightNeighbor && (
               <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="px-3 py-1 bg-[#00F0FF]/10 border border-[#00F0FF]/20 rounded-full"
               >
                 <div className="text-[10px] text-[#00F0FF] font-black tracking-[3px] uppercase">P-{rightNeighbor.playerNumber}</div>
               </motion.div>
             )}
           </div>
        </div>

        {stagedObject ? (
          <motion.div
            drag
            dragConstraints={containerRef}
            dragElastic={0.8}
            onDrag={handleDrag}
            onDragEnd={handleDragEnd}
            animate={controls}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95, cursor: "grabbing" }}
            style={{ 
              borderColor: stagedObject.color, 
              boxShadow: `0 30px 60px ${stagedObject.color}40`
            }}
            className="w-[280px] h-[280px] bg-[#151515]/90 border rounded-[24px] flex flex-col items-center justify-center cursor-grab z-10 box-border relative overflow-hidden backdrop-blur-sm group"
          >
            <div className="absolute inset-0 z-0 pointer-events-none flex items-center justify-center">
               <ObjectIcon obj={stagedObject} size={180} />
            </div>
            
            <div className="absolute top-4 left-4 right-4 flex justify-between items-start z-10 pointer-events-none">
              <div style={{ borderColor: `${stagedObject.color}50`, backgroundColor: `${stagedObject.color}20`, color: stagedObject.color }} className="text-[10px] font-bold uppercase tracking-widest border px-2 py-1 rounded">
                [{stagedObject.category}]
              </div>
            </div>
            
            <div className="absolute bottom-6 text-center z-10 w-full group-hover:opacity-100 transition-opacity">
              <div className="font-black text-xl mb-1 text-white tracking-widest drop-shadow-[0_2px_4px_rgba(0,0,0,1)]">
                {stagedObject.name}
              </div>
              <div style={{ color: stagedObject.color }} className="text-[10px] tracking-[2px] uppercase drop-shadow-[0_2px_4px_rgba(0,0,0,1)]">Hold to Throw &rarr;</div>
            </div>
          </motion.div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-6 z-0">
            <div className="relative w-[280px] h-[280px] flex items-center justify-center">
              <motion.div 
                 animate={{ scale: [1, 1.05, 1], opacity: [0.1, 0.2, 0.1] }} 
                 transition={{ repeat: Infinity, duration: 4 }}
                 className="absolute inset-0 rounded-full bg-[#00F0FF] blur-3xl opacity-20 pointer-events-none"
              />
              <div className="absolute inset-0 pointer-events-none opacity-30 flex items-center justify-center">
                <Box size={140} color="#444" strokeWidth={1} />
              </div>
            </div>
            <div className="text-center absolute bottom-12">
              <div className="text-[60px] md:text-[80px] font-black uppercase tracking-[-2px] leading-[0.8] text-[#222] mb-4">WAITING</div>
              <p className="text-[12px] text-[#666] tracking-[2px] uppercase">
                {myObjects.length > 0 ? "Select an item from Inventory" : "Awaiting incoming objects..."}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Peer Ghost Preview (Half-on-half-off effect) */}
      <AnimatePresence>
        {peerDrag && peerDrag.senderLeft !== -9999 && peerDrag.objectId !== stagedObjectId && (
          <motion.div
            key={`ghost-${peerDrag.objectId}-${peerDrag.senderId}`}
            initial={{ 
              opacity: 0,
              x: peerDrag.direction === 'right' ? peerDrag.senderLeft - peerDrag.senderWidth
                 : peerDrag.direction === 'left' ? peerDrag.senderLeft + window.innerWidth
                 : peerDrag.senderLeft,
              y: peerDrag.direction === 'down' ? peerDrag.senderTop - peerDrag.senderHeight
                 : peerDrag.direction === 'up' ? peerDrag.senderTop + window.innerHeight
                 : peerDrag.senderTop
            }}
            animate={{ 
              opacity: 0.6,
              x: peerDrag.direction === 'right' ? peerDrag.senderLeft - peerDrag.senderWidth
                 : peerDrag.direction === 'left' ? peerDrag.senderLeft + window.innerWidth
                 : peerDrag.senderLeft,
              y: peerDrag.direction === 'down' ? peerDrag.senderTop - peerDrag.senderHeight
                 : peerDrag.direction === 'up' ? peerDrag.senderTop + window.innerHeight
                 : peerDrag.senderTop
            }}
            transition={{ type: 'tween', ease: 'linear', duration: 0.05 }}
            exit={{ opacity: 0 }}
            className="fixed top-0 left-0 pointer-events-none z-30 transform-gpu"
          >
             {gameObjects.find(o => o.id === peerDrag.objectId) && (
               <div className="w-[280px] h-[280px] bg-[#151515]/40 border border-[#00F0FF]/30 rounded-[24px] flex flex-col items-center justify-center backdrop-blur-sm">
                 <ObjectIcon obj={gameObjects.find(o => o.id === peerDrag.objectId)!} size={150} opacity={0.5} />
                 <div className="absolute -top-10 text-[10px] text-[#00F0FF] uppercase tracking-widest font-bold">
                   Incoming from P-{peerDrag.senderPosition}...
                 </div>
               </div>
             )}
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Footer Info */}
      <div className="mt-4 sm:mt-10 flex gap-12 sm:gap-10 items-center justify-center pb-4 z-20 w-full">
         <div className="text-center">
           <div className="text-[9px] sm:text-[11px] text-[#444] uppercase tracking-[1px]">ID DO JOGADOR</div>
           <div className="font-bold text-[13px] sm:text-base">{me ? `P-${me.playerNumber}` : '...'}</div>
         </div>
         <button onClick={() => socket?.emit('reset-state')} className="text-center focus:outline-none hover:opacity-80 transition-opacity cursor-pointer group">
           <div className="text-[9px] sm:text-[11px] text-[#00F0FF] uppercase tracking-[1px] group-hover:text-white transition-colors">SISTEMA</div>
           <div className="font-bold text-[13px] sm:text-base">RESET GAME</div>
         </button>
      </div>

      {/* Notifications */}
      <AnimatePresence>
        {notification && (
          <motion.div
            key={notification.id}
            initial={{ opacity: 0, y: -50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            className="absolute top-24 left-1/2 -translate-x-1/2 z-50 pointer-events-none"
          >
            <div className="bg-[#00F0FF] text-black font-black uppercase text-sm tracking-widest px-6 py-3 shadow-[0_0_20px_rgba(0,240,255,0.4)] flex items-center gap-3">
              <MonitorSmartphone className="w-5 h-5" />
              {notification.message}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* History Panel */}
      <AnimatePresence>
        {showHistory && (
          <motion.div
            initial={{ opacity: 0, x: '100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '100%' }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="absolute inset-y-0 right-0 w-full max-w-sm bg-[#111]/95 backdrop-blur-xl border-l border-[#333] shadow-2xl z-50 flex flex-col"
          >
            <div className="p-6 border-b border-[#333] flex items-center justify-between">
              <div>
                <div className="text-[11px] text-[#00F0FF] uppercase tracking-[2px]">TRANSFER LOGS</div>
                <div className="font-black text-2xl uppercase tracking-tight">HISTORY</div>
              </div>
              <button onClick={() => setShowHistory(false)} className="p-2 hover:bg-[#222] rounded-full transition-colors cursor-pointer text-white">
                <X className="w-6 h-6 text-[#666] hover:text-white" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
              {transferHistory.length === 0 ? (
                <div className="text-center text-[#444] font-bold text-sm tracking-widest uppercase mt-10">
                  NO TRANSFERS YET
                </div>
              ) : (
                transferHistory.map((record, i) => (
                  <div key={record.id} className="bg-[#1A1A1A] border border-[#222] p-4 flex flex-col gap-2">
                    <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-[#666]">
                      <span>{new Date(record.timestamp).toLocaleTimeString()}</span>
                      <span className="text-[#444]">{record.objectName}</span>
                    </div>
                    <div className="flex items-center gap-3 font-bold text-sm mt-1">
                      <div className={`px-2 py-1 ${record.senderId === myId ? 'bg-white text-black' : 'bg-[#333] text-white'}`}>
                        P-{record.senderPosition + 1}
                      </div>
                      <div className="text-[#00F0FF]">&rarr;</div>
                      <div className={`px-2 py-1 ${record.receiverId === myId ? 'bg-[#00F0FF] text-black' : 'bg-[#333] text-white'}`}>
                        P-{record.receiverPosition + 1}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Inventory Panel */}
      <AnimatePresence>
        {showInventory && (
          <motion.div
            initial={{ opacity: 0, x: '-100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '-100%' }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="absolute inset-y-0 left-0 w-full max-w-sm bg-[#111]/95 backdrop-blur-xl border-r border-[#333] shadow-2xl z-50 flex flex-col"
          >
            <div className="p-6 border-b border-[#333] flex items-center justify-between">
              <div>
                <div className="text-[11px] text-[#00F0FF] uppercase tracking-[2px]">YOUR ARSENAL</div>
                <div className="font-black text-2xl uppercase tracking-tight flex items-center gap-2">
                  INVENTORY <span className="text-lg text-[#666]">({myObjects.length})</span>
                </div>
              </div>
              <button onClick={() => setShowInventory(false)} className="p-2 hover:bg-[#222] rounded-full transition-colors cursor-pointer text-white">
                <X className="w-6 h-6 text-[#666] hover:text-white" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-8">
              {myObjects.length === 0 ? (
                <div className="text-center text-[#444] font-bold text-sm tracking-widest uppercase mt-10">
                  INVENTORY EMPTY<br/><span className="text-[10px]">AWAITING TRANSFERS...</span>
                </div>
              ) : (
                Object.entries(inventoryByCategory).map(([category, items]) => (
                  <div key={category}>
                    <h3 className="text-[12px] font-bold text-[#666] uppercase tracking-[3px] mb-4 border-b border-[#222] pb-2">
                      // {category}
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      {items.map(item => (
                        <div 
                          key={item.id} 
                          onClick={() => {
                            setStagedObjectId(item.id);
                            setShowInventory(false); // Close inventory on select
                          }}
                          className={`
                            relative aspect-square border p-3 flex flex-col justify-between cursor-pointer transition-all hover:scale-105 active:scale-95
                            ${stagedObjectId === item.id ? 'bg-[#222] border-white' : 'bg-[#151515] border-[#333] hover:border-[#666]'}
                          `}
                        >
                           <div className="absolute inset-0 opacity-40 pointer-events-none flex items-center justify-center">
                               <ObjectIcon obj={item} size={60} />
                           </div>
                           <div className="z-10 bg-black/60 px-1 inline-block text-[9px] uppercase tracking-widest font-bold self-start rounded-sm" style={{color: item.color}}>
                             {item.shape}
                           </div>
                           <div className="z-10 font-bold text-[11px] uppercase tracking-wider bg-black/80 p-1 rounded">
                             {item.name}
                           </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Canvas/Creation Modal */}
      <AnimatePresence>
        {showCanvas && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md p-4"
          >
            <div className="bg-[#151515] border border-[#333] rounded-[24px] sm:rounded-[32px] p-4 sm:p-8 max-w-xl w-full flex flex-col items-center shadow-[0_0_100px_rgba(0,0,0,0.5)] max-h-[96vh] overflow-y-auto">
              <div className="w-full flex justify-between items-center mb-4 sm:mb-8">
                <div>
                  <div className="text-[9px] sm:text-[11px] text-[#00F0FF] uppercase tracking-[3px] font-black hidden sm:block">FABRICATOR_v2</div>
                  <div className="font-black text-xl sm:text-3xl uppercase tracking-tighter">NEW ARTIFACT</div>
                </div>
                <button onClick={() => setShowCanvas(false)} className="p-2 sm:p-3 hover:bg-[#222] rounded-full transition-all cursor-pointer text-white">
                  <X className="w-6 h-6 text-[#666] hover:text-white" />
                </button>
              </div>

              {/* Mode Selection */}
              <div className="w-full grid grid-cols-2 gap-2 mb-4 sm:mb-8 bg-[#111] p-1 rounded-2xl border border-[#222]">
                <button 
                  onClick={() => setSelectedCreationMode('doodle')}
                  className={`py-2 sm:py-3 rounded-xl font-bold uppercase tracking-widest text-[10px] sm:text-[11px] transition-all flex items-center justify-center gap-2 ${selectedCreationMode === 'doodle' ? 'bg-[#222] text-[#00F0FF] border border-[#333] shadow-lg' : 'text-[#666] hover:text-[#999]'}`}
                >
                  <PenTool className="w-4 h-4" /> 2D Doodle
                </button>
                <button 
                  onClick={() => setSelectedCreationMode('shape')}
                  className={`py-2 sm:py-3 rounded-xl font-bold uppercase tracking-widest text-[10px] sm:text-[11px] transition-all flex items-center justify-center gap-2 ${selectedCreationMode === 'shape' ? 'bg-[#222] text-[#00F0FF] border border-[#333] shadow-lg' : 'text-[#666] hover:text-[#999]'}`}
                >
                  <Sparkles className="w-4 h-4" /> 3D Geometries
                </button>
              </div>
              
              <div className="w-full flex flex-col items-center justify-center min-h-[260px] sm:min-h-[340px]">
                {selectedCreationMode === 'doodle' ? (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-col items-center w-full"
                  >
                    <div className="border-2 border-[#333] rounded-2xl overflow-hidden shadow-[0_0_50px_rgba(0,240,255,0.05)] bg-[#050505] relative group">
                      <canvas
                        ref={drawingCanvasRef}
                        width={240}
                        height={240}
                        className="touch-none cursor-crosshair w-[240px] sm:w-[280px] h-[240px] sm:h-[280px]"
                        onMouseDown={startDrawing}
                        onMouseMove={draw}
                        onMouseUp={stopDrawing}
                        onMouseOut={stopDrawing}
                        onTouchStart={startDrawing}
                        onTouchMove={draw}
                        onTouchEnd={stopDrawing}
                      />
                      <button 
                        onClick={clearDrawing}
                        className="absolute bottom-4 right-4 bg-black/80 hover:bg-black p-2 rounded-lg border border-[#333] opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <History className="w-4 h-4 text-[#666]" />
                      </button>
                    </div>

                    {/* Thickness Selector */}
                    <div className="flex bg-[#111] border border-[#222] rounded-full mt-4 sm:mt-6 overflow-hidden">
                      {[ 
                        { label: 'S', value: 1 }, 
                        { label: 'M', value: 3 }, 
                        { label: 'L', value: 6 }, 
                        { label: 'XL', value: 10 } 
                      ].map(size => (
                        <button
                          key={size.value}
                          onClick={() => setBrushSize(size.value)}
                          className={`px-3 sm:px-4 py-1.5 sm:py-2 text-[10px] font-black tracking-[1px] transition-colors ${brushSize === size.value ? 'bg-[#00F0FF] text-black' : 'text-[#666] hover:text-white'}`}
                        >
                          {size.label}
                        </button>
                      ))}
                    </div>
                  </motion.div>
                ) : (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="w-full flex-1 flex flex-col items-center justify-center py-2 sm:py-6"
                  >
                    <div className="flex gap-4 sm:gap-6 items-center justify-center w-full flex-wrap sm:flex-nowrap">
                      {shapeTypes.map((type) => {
                        const Icon = type.icon;
                        return (
                          <button
                            key={type.id}
                            onClick={() => setSelectedShape(type.id as any)}
                            className={`flex flex-col items-center gap-2 sm:gap-3 p-4 sm:p-6 rounded-[20px] sm:rounded-3xl border transition-all duration-300 w-[100px] sm:min-w-[120px] ${selectedShape === type.id ? 'bg-[#222] border-[#00F0FF] scale-105 sm:scale-110 shadow-[0_0_30px_rgba(0,240,255,0.2)]' : 'bg-[#111] border-[#222] opacity-50 hover:opacity-100'}`}
                          >
                            <Icon className={`w-8 h-8 sm:w-12 sm:h-12 ${selectedShape === type.id ? 'text-[#00F0FF]' : 'text-[#666]'}`} />
                            <span className="text-[10px] font-black uppercase tracking-[2px]">{type.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </div>

              {/* Color Picker */}
              <div className="flex flex-wrap justify-center gap-2 sm:gap-4 my-4 sm:my-8 p-3 sm:p-4 bg-[#111] rounded-2xl sm:rounded-full border border-[#222] w-full">
                {colors.map(color => (
                  <button
                    key={color}
                    onClick={() => setSelectedColor(color)}
                    className={`w-7 h-7 sm:w-10 sm:h-10 rounded-full border-2 transition-all duration-300 transform ${selectedColor === color ? 'border-white scale-125 shadow-[0_0_20px_rgba(255,255,255,0.3)]' : 'border-transparent opacity-40 hover:opacity-100'}`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>

              <div className="w-full flex gap-4 mt-0 sm:mt-2">
                <button 
                  onClick={handleCreate} 
                  className="flex-1 py-3 sm:py-5 text-sm font-black uppercase tracking-[4px] bg-[#00F0FF] text-black hover:bg-white active:scale-[0.98] transition-all rounded-3xl flex items-center justify-center gap-2 shadow-[0_10px_30px_rgba(0,240,255,0.2)]"
                >
                  <Package className="w-5 h-5" /> INITIALIZE ARTIFACT
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
