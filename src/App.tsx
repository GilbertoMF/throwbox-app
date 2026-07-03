import React, { useEffect, useState, useRef } from 'react';
import { motion, useAnimation, AnimatePresence } from 'motion/react';
import { io, Socket } from 'socket.io-client';
import { MonitorSmartphone, Users, History, X, Package, PenTool, Octagon, Box, Circle, Triangle, Image as ImageIcon, Sparkles, Download } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { GoogleAuth } from '@codetrix-studio/capacitor-google-auth';

const playSound = (type: 'whoosh' | 'impact', pitchMultiplier = 1) => {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    const now = ctx.currentTime;
    
    if (type === 'whoosh') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(100, now);
      osc.frequency.linearRampToValueAtTime(600, now + 0.35);
      
      // Smooth attack/release to prevent clicks
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.08, now + 0.08); // 80ms fade-in
      gain.gain.linearRampToValueAtTime(0, now + 0.35);    // fade-out
      
      osc.start(now);
      osc.stop(now + 0.4); // stop 50ms after fade-out completes
    } else {
      osc.type = 'sine'; // sine is cleaner than triangle, avoiding clipping harmonics
      const baseFreq = 480 * pitchMultiplier;
      osc.frequency.setValueAtTime(baseFreq, now);
      osc.frequency.linearRampToValueAtTime(baseFreq / 2.2, now + 0.4);
      
      // Fast attack/release envelope
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.02); // 20ms quick fade-in
      gain.gain.linearRampToValueAtTime(0, now + 0.38);    // fade-out
      
      osc.start(now);
      osc.stop(now + 0.42); // stop after fade-out completes
    }
  } catch (e) {
    console.warn('Audio synthesis failed:', e);
  }
};

const triggerHaptic = (type: 'throw' | 'receive') => {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    try {
      if (type === 'throw') {
        navigator.vibrate(60);
      } else {
        navigator.vibrate([40, 50, 80]);
      }
    } catch (e) {
      console.warn('Haptic vibration failed:', e);
    }
  }
};

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

interface Particle {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  opacity: number;
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
  const CLIENT_VERSION = '1.0.0';
  
  // Initialize native Google Sign-in on mount
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      try {
        GoogleAuth.initialize({
          grantOfflineAccess: true
        });
      } catch (e) {
        console.warn("GoogleAuth initialize warning:", e);
      }
    }
  }, []);

  // Auth & Google Drive States
  const [sessionToken, setSessionToken] = useState<string | null>(localStorage.getItem('throwbox_session_token'));
  const [user, setUser] = useState<{ id: string; email: string; is_drive_linked: boolean } | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [driveSaving, setDriveSaving] = useState<string | null>(null); // holds objectId being saved
  const [updateInfo, setUpdateInfo] = useState<{ hasUpdate: boolean; latestVersion: string; apkUrl: string } | null>(null);
  const [config, setConfig] = useState({ primaryColor: '#00F0FF', primaryColorDark: '#00D0DF' });
  const [roomCode, setRoomCode] = useState('global');
  const [inputRoomCode, setInputRoomCode] = useState('');
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [particles, setParticles] = useState<Particle[]>([]);
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
  const colors = [config.primaryColor, '#FF00FF', '#00FF00', '#FFFF00', '#FF4444', '#FFFFFF'];

  useEffect(() => {
    setSelectedColor(config.primaryColor);
  }, [config.primaryColor]);

  const spawnPortalParticles = (direction: 'left' | 'right' | 'up' | 'down', color: string) => {
    const count = 25;
    const newParticles: Particle[] = [];
    const width = window.innerWidth;
    const height = window.innerHeight;

    let startX = 0;
    let startY = 0;

    if (direction === 'left') {
      startX = 10;
      startY = height / 2;
    } else if (direction === 'right') {
      startX = width - 10;
      startY = height / 2;
    } else if (direction === 'up') {
      startX = width / 2;
      startY = 10;
    } else if (direction === 'down') {
      startX = width / 2;
      startY = height - 10;
    }

    for (let i = 0; i < count; i++) {
      let angle = 0;
      if (direction === 'left') {
        angle = (Math.random() - 0.5) * Math.PI; // inward right
      } else if (direction === 'right') {
        angle = Math.PI + (Math.random() - 0.5) * Math.PI; // inward left
      } else if (direction === 'up') {
        angle = Math.PI / 2 + (Math.random() - 0.5) * Math.PI; // inward down
      } else if (direction === 'down') {
        angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI; // inward up
      }

      const speed = 3 + Math.random() * 8;
      newParticles.push({
        id: `${Date.now()}-${i}-${Math.random()}`,
        x: direction === 'left' || direction === 'right' ? startX : Math.random() * width,
        y: direction === 'up' || direction === 'down' ? startY : Math.random() * height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 3 + Math.random() * 6,
        color,
        opacity: 1
      });
    }
    setParticles(prev => [...prev, ...newParticles]);
  };

  useEffect(() => {
    if (particles.length === 0) return;

    let active = true;
    let frameId = 0;
    
    const update = () => {
      if (!active) return;
      setParticles(prev => {
        const next = prev
          .map(p => ({
            ...p,
            x: p.x + p.vx,
            y: p.y + p.vy,
            opacity: p.opacity - 0.04
          }))
          .filter(p => p.opacity > 0);
        return next;
      });
      frameId = requestAnimationFrame(update);
    };

    frameId = requestAnimationFrame(update);
    return () => {
      active = false;
      cancelAnimationFrame(frameId);
    };
  }, [particles.length]);

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
    (((window as any).Capacitor || window.location.protocol === 'capacitor:') ? 'https://p01--throwbox--qhc8zm2mxs4g.code.run' : '');

  const baseUrl = socketUrl || window.location.origin;

  // Load configuration on mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const res = await fetch(`${baseUrl}/api/config`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.primaryColor) {
          setConfig({
            primaryColor: data.primaryColor,
            primaryColorDark: data.primaryColorDark || data.primaryColor
          });
          // Update CSS custom properties
          document.documentElement.style.setProperty('--primary-color', data.primaryColor);
          if (data.primaryColorDark) {
            document.documentElement.style.setProperty('--primary-color-dark', data.primaryColorDark);
          }
        }
      } catch (err) {
        console.error('Failed to load server config:', err);
      }
    };
    loadConfig();
  }, [baseUrl]);

  useEffect(() => {
    const checkVersion = async () => {
      // Only check version and block screen for updates on mobile (Capacitor native app)
      if (window.location.protocol !== 'capacitor:') return;

      try {
        const res = await fetch(`${baseUrl}/api/version`);
        if (!res.ok) return;
        const data = await res.json();
        
        if (data.version && data.version !== CLIENT_VERSION) {
          const latestParts = data.version.split('.').map(Number);
          const currentParts = CLIENT_VERSION.split('.').map(Number);
          
          let hasUpdate = false;
          for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
            const latest = latestParts[i] || 0;
            const current = currentParts[i] || 0;
            if (latest > current) {
              hasUpdate = true;
              break;
            } else if (current > latest) {
              break;
            }
          }
          
          if (hasUpdate) {
            setUpdateInfo({
              hasUpdate: true,
              latestVersion: data.version,
              apkUrl: data.apkUrl || 'https://github.com/GilbertoMF/throwbox-app/releases'
            });
          }
        }
      } catch (err) {
        console.error('Failed to check app version:', err);
      }
    };

    checkVersion();
  }, [baseUrl]);
  // Dynamically load Google Identity Services library
  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, []);

  // Fetch user profile on token change
  useEffect(() => {
    if (!sessionToken) {
      setUser(null);
      return;
    }

    const fetchProfile = async () => {
      try {
        const res = await fetch(`${baseUrl}/api/auth/me`, {
          headers: {
            'Authorization': `Bearer ${sessionToken}`
          }
        });
        const data = await res.json();
        if (res.ok && data.user) {
          setUser(data.user);
        } else {
          localStorage.removeItem('throwbox_session_token');
          setSessionToken(null);
        }
      } catch (err) {
        console.error("Failed to fetch user profile:", err);
      }
    };
    fetchProfile();
  }, [sessionToken, baseUrl]);

  // Handle Google OAuth Redirect Callbacks
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    
    if (code) {
      const newUrl = window.location.pathname;
      window.history.replaceState({}, document.title, newUrl);
      
      const processOAuthCallback = async () => {
        if (!state) return;
        
        if (state === 'login') {
          setAuthLoading(true);
          setAuthError(null);
          try {
            const res = await fetch(`${baseUrl}/api/auth/google/login`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ 
                code,
                redirectUri: "http://localhost:3000/api/auth/google/callback"
              })
            });
            const data = await res.json();
            if (res.ok && data.token) {
              localStorage.setItem('throwbox_session_token', data.token);
              setSessionToken(data.token);
              setUser(data.user);
              setIsAuthModalOpen(false);
            } else {
              setAuthError(data.error || 'Erro ao processar login com o Google.');
            }
          } catch (err: any) {
            setAuthError(`Erro de rede: ${err.message}`);
          } finally {
            setAuthLoading(false);
          }
        } else if (state.startsWith('link_drive:')) {
          const storedToken = state.split(':')[1];
          try {
            const res = await fetch(`${baseUrl}/api/auth/google/token`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${storedToken}`
              },
              body: JSON.stringify({ 
                code,
                redirectUri: "http://localhost:3000/api/auth/google/callback"
              })
            });
            const data = await res.json();
            if (res.ok) {
              alert("Google Drive vinculado com sucesso!");
              setUser(prev => prev ? { ...prev, is_drive_linked: true } : null);
            } else {
              alert(`Erro ao vincular Google Drive: ${data.error || 'Erro desconhecido'}`);
            }
          } catch (err: any) {
            alert(`Erro de rede: ${err.message}`);
          }
        }
      };
      
      processOAuthCallback();
    }
  }, [baseUrl]);

  const handleLinkGoogleDrive = async () => {
    if (!user) return;

    const confirmMessage = `Deseja vincular o Google Drive da conta "${user.email}"?`;
    if (!window.confirm(confirmMessage)) return;

    if (Capacitor.isNativePlatform()) {
      try {
        const googleUser = await GoogleAuth.signIn();
        const serverAuthCode = googleUser.serverAuthCode;
        if (!serverAuthCode) {
          throw new Error("Não foi possível obter o código de autorização nativo do Google.");
        }

        const res = await fetch(`${baseUrl}/api/auth/google/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${sessionToken}`
          },
          body: JSON.stringify({ code: serverAuthCode })
        });
        const data = await res.json();
        if (res.ok) {
          alert("Google Drive vinculado com sucesso!");
          setUser(prev => prev ? { ...prev, is_drive_linked: true } : null);
        } else {
          alert(`Erro ao vincular Google Drive: ${data.error || 'Erro desconhecido'}`);
        }
      } catch (err: any) {
        alert(`Erro no vínculo nativo: ${err.message || JSON.stringify(err)}`);
      }
    } else {
      const client_id = "569049899903-rb5qc608qpdnt8vkqv66dl4ctkdjvnfq.apps.googleusercontent.com";
      const redirect_uri = "http://localhost:3000/api/auth/google/callback";
      const scope = "https://www.googleapis.com/auth/drive.file";
      const state = `link_drive:${sessionToken}`;
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${client_id}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}&prompt=select_account%20consent&access_type=offline&login_hint=${encodeURIComponent(user?.email || '')}`;
      
      window.location.href = authUrl;
    }
  };

  const handleGoogleLogin = async () => {
    if (Capacitor.isNativePlatform()) {
      setAuthLoading(true);
      setAuthError(null);
      try {
        const googleUser = await GoogleAuth.signIn();
        const idToken = googleUser.authentication.idToken;
        if (!idToken) throw new Error("ID Token não retornado pelo Google.");

        const res = await fetch(`${baseUrl}/api/auth/google/one-tap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credential: idToken })
        });
        const data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('throwbox_session_token', data.token);
          setSessionToken(data.token);
          setUser(data.user);
          setIsAuthModalOpen(false);
        } else {
          setAuthError(data.error || 'Erro no login nativo com o Google.');
        }
      } catch (err: any) {
        setAuthError(`Erro no login nativo: ${err.message || JSON.stringify(err)}`);
      } finally {
        setAuthLoading(false);
      }
    } else {
      const client_id = "569049899903-rb5qc608qpdnt8vkqv66dl4ctkdjvnfq.apps.googleusercontent.com";
      const redirect_uri = "http://localhost:3000/api/auth/google/callback";
      const scope = "openid email";
      const state = "login";
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${client_id}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`;
      
      window.location.href = authUrl;
    }
  };

  const handleSaveToDrive = async (objectId: string, objectName: string, drawingData: string) => {
    if (!sessionToken) {
      setAuthMode('login');
      setIsAuthModalOpen(true);
      return;
    }
    if (!user?.is_drive_linked) {
      alert("Você precisa vincular o seu Google Drive primeiro.");
      return;
    }
    
    setDriveSaving(objectId);
    try {
      const res = await fetch(`${baseUrl}/api/drive/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ objectName, drawingData })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const notifId = Date.now();
        setNotification({
          id: notifId,
          message: `SALVO NO GOOGLE DRIVE: ${objectName}`
        });
        setTimeout(() => setNotification(prev => prev?.id === notifId ? null : prev), 4000);
      } else {
        alert(`Erro ao salvar no Drive: ${data.error || 'Erro desconhecido'}`);
      }
    } catch (err: any) {
      alert(`Erro na requisição: ${err.message}`);
    } finally {
      setDriveSaving(null);
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);
    
    const endpoint = authMode === 'login' ? 'login' : 'register';
    try {
      const res = await fetch(`${baseUrl}/api/auth/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authEmail, password: authPassword })
      });
      const data = await res.json();
      if (res.ok && data.token) {
        localStorage.setItem('throwbox_session_token', data.token);
        setSessionToken(data.token);
        setUser(data.user);
        setIsAuthModalOpen(false);
        setAuthEmail('');
        setAuthPassword('');
      } else {
        setAuthError(data.error || 'Ocorreu um erro.');
      }
    } catch (err: any) {
      setAuthError(`Erro de rede: ${err.message}`);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    localStorage.removeItem('throwbox_session_token');
    setSessionToken(null);
    setUser(null);
    if (Capacitor.isNativePlatform()) {
      try {
        await GoogleAuth.signOut();
      } catch (e) {
        console.error("Erro ao deslogar do Google nativo:", e);
      }
    }
  };
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
        
        // Trigger sound, vibration, and particles
        playSound('impact');
        triggerHaptic('receive');
        
        // Find color of object
        const objColor = gameObjects.find(o => o.id === data.objectId)?.color || config.primaryColor;
        const oppositeDirs: Record<string, 'left' | 'right' | 'up' | 'down'> = {
          left: 'right',
          right: 'left',
          up: 'down',
          down: 'up'
        };
        spawnPortalParticles(oppositeDirs[data.direction], objColor);

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

  // Gyroscope flick-to-throw listener
  const lastUpdate = useRef(0);
  const isThresholdMet = useRef(false);

  useEffect(() => {
    if (!motionEnabled || !stagedObject || !socket) return;

    const handleMotion = (event: DeviceMotionEvent) => {
      const now = Date.now();
      if (now - lastUpdate.current < 250) return; // Debounce sensor readings (250ms)

      const acc = event.acceleration || event.accelerationIncludingGravity;
      if (!acc) return;

      const x = acc.x || 0;
      const y = acc.y || 0;
      
      // Threshold for a rapid motion (m/s^2)
      const FLICK_THRESHOLD = 20;

      if (Math.abs(x) > FLICK_THRESHOLD || Math.abs(y) > FLICK_THRESHOLD) {
        if (isThresholdMet.current) return;
        isThresholdMet.current = true;
        setTimeout(() => { isThresholdMet.current = false; }, 1200); // 1.2s throw lock/debounce
        
        lastUpdate.current = now;

        // Determine dominant direction
        if (Math.abs(x) > Math.abs(y)) {
          if (x < 0) {
            executeThrow('right');
          } else {
            executeThrow('left');
          }
        } else {
          if (y < 0) {
            executeThrow('down');
          } else {
            executeThrow('up');
          }
        }
      }
    };

    window.addEventListener('devicemotion', handleMotion);
    return () => window.removeEventListener('devicemotion', handleMotion);
  }, [motionEnabled, stagedObjectId, socket, stagedObject]);

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

  const executeThrow = (direction: 'left' | 'right' | 'up' | 'down') => {
    if (!socket || !stagedObject) return;

    playSound('whoosh');
    triggerHaptic('throw');
    spawnPortalParticles(direction, stagedObject.color);

    setActivePortal(direction);

    let targetX = 0;
    let targetY = 0;
    if (direction === 'right') targetX = window.innerWidth * 0.8;
    else if (direction === 'left') targetX = -window.innerWidth * 0.8;
    else if (direction === 'down') targetY = window.innerHeight * 0.8;
    else if (direction === 'up') targetY = -window.innerHeight * 0.8;

    controls.start({
      x: targetX,
      y: targetY,
      scale: 0.5,
      opacity: 0,
      rotate: direction === 'left' || direction === 'up' ? -45 : 45,
      transition: { duration: 0.2 }
    }).then(() => {
      socket.emit('transfer-object', { objectId: stagedObject.id, direction });
      setStagedObjectId(null);
      setTimeout(() => setActivePortal(null), 500);
    });
  };

  const handleDragEnd = (event: any, info: any) => {
    if (!socket || !stagedObject) return;
    const x = info.offset.x;
    const y = info.offset.y;
    const threshold = 120;

    if (x > threshold) {
      executeThrow('right');
    } else if (x < -threshold) {
      executeThrow('left');
    } else if (y > threshold) {
      executeThrow('down');
    } else if (y < -threshold) {
      executeThrow('up');
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
      
      {/* Dynamic style overrides based on server config */}
      <style>{`
        .text-\\[\\#00F0FF\\] { color: ${config.primaryColor} !important; }
        .bg-\\[\\#00F0FF\\] { background-color: ${config.primaryColor} !important; }
        .border-\\[\\#00F0FF\\] { border-color: ${config.primaryColor} !important; }
        .border-\\[\\#00F0FF\\]\\/20 { border-color: ${config.primaryColor}33 !important; }
        .border-\\[\\#00F0FF\\]\\/30 { border-color: ${config.primaryColor}4d !important; }
        .bg-\\[\\#00F0FF\\]\\/10 { background-color: ${config.primaryColor}1a !important; }
        .from-\\[\\#00F0FF\\] { --tw-gradient-from: ${config.primaryColor} !important; --tw-gradient-to: ${config.primaryColor}00 !important; --tw-gradient-stops: var(--tw-gradient-from), var(--tw-gradient-to) !important; }
        .via-\\[\\#00F0FF\\] { --tw-gradient-to: ${config.primaryColor}00 !important; --tw-gradient-stops: var(--tw-gradient-from), ${config.primaryColor} !important; }
        .hover\\:bg-\\[\\#00D0DF\\]:hover { background-color: ${config.primaryColorDark} !important; }
        .shadow-\\[10px_0_30px_\\#00F0FF50\\] { box-shadow: 10px 0 30px ${config.primaryColor}80 !important; }
        .shadow-\\[-10px_0_30px_\\#00F0FF50\\] { box-shadow: -10px 0 30px ${config.primaryColor}80 !important; }
        .shadow-\\[0_0_20px_rgba\\(0\\,240\\,255\\,0\\.4\\)\\] { box-shadow: 0 0 20px ${config.primaryColor}66 !important; }
        .shadow-\\[0_10px_30px_rgba\\(0\\,240\\,255\\,0\\.2\\)\\] { box-shadow: 0 10px 30px ${config.primaryColor}33 !important; }
        .shadow-\\[0_0_50px_rgba\\(0\\,240\\,255\\,0\\.15\\)\\] { box-shadow: 0 0 50px ${config.primaryColor}26 !important; }
        .shadow-\\[0_0_20px_rgba\\(0\\,240\\,255\\,0\\.3\\)\\] { box-shadow: 0 0 20px ${config.primaryColor}4d !important; }
        .shadow-\\[0_0_30px_rgba\\(0\\,240\\,255\\,0\\.2\\)\\] { box-shadow: 0 0 30px ${config.primaryColor}33 !important; }
      `}</style>

      {/* Render Portal Particles */}
      {particles.map(p => (
        <div 
          key={p.id}
          className="absolute rounded-full pointer-events-none z-50 shadow-glow"
          style={{
            left: p.x,
            top: p.y,
            width: p.size,
            height: p.size,
            backgroundColor: p.color,
            opacity: p.opacity,
            boxShadow: `0 0 10px ${p.color}, 0 0 20px ${p.color}`
          }}
        />
      ))}

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
            <div className="flex flex-col gap-0.5 mt-1">
              {me && (
                <div className="text-[10px] text-[#888] font-mono tracking-[1px]">
                  MEU ID: P-{me.playerNumber}
                </div>
              )}
              {user ? (
                <div className="text-[10px] text-[#888] font-mono flex items-center gap-1.5 flex-wrap">
                  <span className="text-white/70">👤 {user.email}</span>
                  {!user.is_drive_linked ? (
                    <button onClick={handleLinkGoogleDrive} className="text-[#00F0FF] hover:underline cursor-pointer font-bold">
                      [Vincular Drive]
                    </button>
                  ) : (
                    <span className="text-green-500 font-bold">[Drive Conectado]</span>
                  )}
                  <button onClick={handleLogout} className="text-red-400 hover:underline cursor-pointer">
                    [Sair]
                  </button>
                </div>
              ) : (
                <button onClick={() => { setAuthMode('login'); setIsAuthModalOpen(true); }} className="text-[10px] text-[#00F0FF] hover:underline text-left cursor-pointer font-bold">
                  🔑 Fazer Login / Cadastrar
                </button>
              )}
            </div>
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

      {/* Room Selection & Motion Controls Settings Bar */}
      <div className="w-full max-w-lg mt-4 flex flex-col items-center gap-3 bg-[#111]/60 border border-white/5 rounded-2xl p-4 backdrop-blur-md z-20">
        <div className="w-full flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-[9px] text-[#555] uppercase tracking-[2px] font-bold">LOBBY / SALA</span>
            <span className="text-xs font-mono font-bold tracking-[1px] text-white">
              {roomCode === 'global' ? '🌐 LOBBY PÚBLICO' : `🔒 SALA: ${roomCode}`}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {roomCode === 'global' ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
                    setRoomCode(code);
                    socket?.emit('join-room', { roomCode: code });
                  }}
                  className="px-3 py-1.5 bg-[#222] border border-[#333] hover:border-[#00F0FF]/30 text-white rounded-lg text-[10px] font-black uppercase tracking-[1px] transition-colors"
                >
                  Criar Sala
                </button>
                <div className="flex items-center bg-[#222] border border-[#333] rounded-lg px-2 py-1">
                  <input
                    type="text"
                    placeholder="CÓDIGO"
                    value={inputRoomCode}
                    onChange={(e) => setInputRoomCode(e.target.value.toUpperCase().slice(0, 4))}
                    className="w-14 bg-transparent outline-none border-none text-[10px] font-mono font-bold tracking-[1px] text-white"
                  />
                  <button
                    onClick={() => {
                      if (inputRoomCode.length === 4) {
                        setRoomCode(inputRoomCode);
                        socket?.emit('join-room', { roomCode: inputRoomCode });
                      }
                    }}
                    className="ml-1 text-[10px] font-black text-[#00F0FF] hover:text-white transition-colors"
                  >
                    Entrar
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setRoomCode('global');
                  socket?.emit('join-room', { roomCode: 'global' });
                }}
                className="px-3 py-1.5 bg-red-950/40 border border-red-500/20 hover:bg-red-900/60 text-red-400 rounded-lg text-[10px] font-black uppercase tracking-[1px] transition-all"
              >
                Sair da Sala
              </button>
            )}
          </div>
        </div>

        {/* Gyroscope Motion Controls Toggle */}
        <div className="w-full flex items-center justify-between pt-2 border-t border-white/5">
          <div className="flex flex-col">
            <span className="text-[9px] text-[#555] uppercase tracking-[2px] font-bold">CONTROLE DE MOVIMENTO</span>
            <span className="text-[10px] text-[#888]">
              {motionEnabled ? '📱 Balance para arremessar itens' : '📴 Controles físicos desativados'}
            </span>
          </div>

          <button
            onClick={() => {
              if (!motionEnabled) {
                // Request Permission on iOS if available
                if (typeof DeviceMotionEvent !== 'undefined' && (DeviceMotionEvent as any).requestPermission) {
                  (DeviceMotionEvent as any).requestPermission()
                    .then((permissionState: string) => {
                      if (permissionState === 'granted') {
                        setMotionEnabled(true);
                      } else {
                        alert('Permissão de movimento negada pelo usuário.');
                      }
                    })
                    .catch(console.error);
                } else {
                  setMotionEnabled(true);
                }
              } else {
                setMotionEnabled(false);
              }
            }}
            className={`px-3 py-1 bg-[#222] border rounded-lg text-[9px] font-bold uppercase transition-all ${motionEnabled ? 'text-[#00F0FF] border-[#00F0FF]/30' : 'text-neutral-500 border-neutral-800'}`}
          >
            {motionEnabled ? 'Ativo' : 'Inativo'}
          </button>
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
                           <div className="z-10 flex justify-between items-center w-full">
                             <div className="bg-black/60 px-1 inline-block text-[9px] uppercase tracking-widest font-bold rounded-sm" style={{color: item.color}}>
                               {item.shape}
                             </div>
                             {item.shape === 'plane' && item.drawingData && (
                               <button 
                                 onClick={(e) => {
                                   e.stopPropagation();
                                   handleSaveToDrive(item.id, item.name, item.drawingData!);
                                 }}
                                 className="z-20 px-1.5 py-0.5 bg-black/80 hover:bg-[#222] border border-white/5 hover:border-[#00F0FF]/30 rounded transition-colors text-[8px] font-bold text-[#00F0FF] uppercase tracking-[1px] cursor-pointer flex items-center gap-1"
                                 disabled={driveSaving !== null}
                               >
                                 {driveSaving === item.id ? '...' : '💾 Drive'}
                               </button>
                             )}
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

      {/* Update Modal Overlay */}
      <AnimatePresence>
        {updateInfo && updateInfo.hasUpdate && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/90 backdrop-blur-md z-[100] flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="w-full max-w-md bg-[#151515] border border-[#00F0FF]/30 rounded-[28px] p-8 text-center flex flex-col items-center gap-6 shadow-[0_0_50px_rgba(0,240,255,0.15)] relative overflow-hidden"
            >
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-[#00F0FF] to-transparent" />
              
              <div className="w-16 h-16 rounded-full bg-[#00F0FF]/10 flex items-center justify-center border border-[#00F0FF]/20 animate-pulse-slow">
                <Sparkles className="w-8 h-8 text-[#00F0FF]" />
              </div>

              <div>
                <h2 className="text-2xl font-black uppercase tracking-wider text-white">
                  Update Available
                </h2>
                <p className="text-[11px] text-[#00F0FF] uppercase tracking-[3px] font-bold mt-1">
                  Version {updateInfo.latestVersion} is out!
                </p>
              </div>

              <p className="text-sm text-[#888] leading-relaxed max-w-xs">
                A new version of ThrowBox is available with improvements and compatibility updates. Please update to continue playing.
              </p>

              <div className="w-full flex flex-col gap-3 mt-2">
                <a
                  href={updateInfo.apkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full py-4 bg-[#00F0FF] hover:bg-[#00D0DF] text-black font-black uppercase text-xs tracking-widest transition-all rounded-xl shadow-[0_0_20px_rgba(0,240,255,0.3)] hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer text-center"
                >
                  <Download className="w-4 h-4" /> Download APK
                </a>
                <div className="text-[9px] text-[#444] uppercase tracking-wider font-mono">
                  Current Version: {CLIENT_VERSION}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Auth Modal Overlay */}
      <AnimatePresence>
        {isAuthModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/85 backdrop-blur-md z-[99] flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              transition={{ type: "spring", damping: 25, stiffness: 220 }}
              className="w-full max-w-sm bg-[#121212] border border-white/5 rounded-[24px] p-6 shadow-2xl relative overflow-hidden flex flex-col gap-5"
            >
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-[#00F0FF] to-transparent" />
              
              <div className="flex justify-between items-center">
                <div>
                  <div className="text-[10px] text-[#00F0FF] uppercase tracking-[3px] font-bold">DATABASE SYNC</div>
                  <h2 className="text-xl font-black uppercase tracking-tight text-white mt-0.5">
                    {authMode === 'login' ? '🔑 ACESSAR CONTA' : '📝 CADASTRAR CONTA'}
                  </h2>
                </div>
                <button 
                  onClick={() => {
                    setIsAuthModalOpen(false);
                    setAuthError(null);
                  }}
                  className="p-1.5 hover:bg-[#222] rounded-full transition-colors cursor-pointer text-[#555] hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {authError && (
                <div className="bg-red-950/45 border border-red-500/20 text-red-400 p-3 rounded-xl text-xs font-medium leading-relaxed">
                  ⚠️ {authError}
                </div>
              )}

              {/* Google Sign-In Button */}
              <button
                type="button"
                onClick={handleGoogleLogin}
                disabled={authLoading}
                className="w-full py-3 bg-white hover:bg-neutral-100 text-black font-black uppercase text-[10px] tracking-widest transition-all rounded-xl cursor-pointer flex items-center justify-center gap-2 shadow-[0_2px_8px_rgba(255,255,255,0.05)]"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24">
                  <path fill="#EA4335" d="M12 5.04c1.66 0 3.2.57 4.38 1.69l3.27-3.27C17.67 1.58 15.01 1 12 1 7.28 1 3.25 3.72 1.34 7.69l3.85 2.99C6.1 7.64 8.79 5.04 12 5.04z"/>
                  <path fill="#4285F4" d="M23.49 12.27c0-.81-.07-1.59-.2-2.34H12v4.58h6.43c-.28 1.48-1.11 2.73-2.37 3.58l3.7 2.87c2.16-1.99 3.43-4.92 3.43-8.69z"/>
                  <path fill="#FBBC05" d="M5.19 14.82c-.25-.74-.39-1.53-.39-2.35s.14-1.61.39-2.35L1.34 7.13C.49 8.83 0 10.73 0 12.75s.49 3.92 1.34 5.62l3.85-3.55z"/>
                  <path fill="#34A853" d="M12 23c3.24 0 5.97-1.07 7.96-2.91l-3.7-2.87c-1.03.69-2.35 1.1-4.26 1.1-3.21 0-5.9-2.6-6.81-5.64L1.34 16.27C3.25 20.28 7.28 23 12 23z"/>
                </svg>
                {authMode === 'login' ? 'Entrar com o Google' : 'Cadastrar com o Google'}
              </button>

              <div className="flex items-center gap-3 w-full">
                <div className="flex-1 h-[1px] bg-white/5" />
                <span className="text-[9px] text-[#444] uppercase tracking-widest font-black">OU</span>
                <div className="flex-1 h-[1px] bg-white/5" />
              </div>
              <form onSubmit={handleAuthSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[9px] text-[#555] uppercase tracking-[2px] font-bold">E-mail</label>
                  <input
                    type="email"
                    required
                    placeholder="seu@email.com"
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    className="w-full bg-[#1c1c1c] border border-white/5 focus:border-[#00F0FF]/30 rounded-xl px-4 py-3 text-xs text-white outline-none transition-colors placeholder:text-neutral-600"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[9px] text-[#555] uppercase tracking-[2px] font-bold">Senha</label>
                  <input
                    type="password"
                    required
                    placeholder="Sua senha secreta"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    className="w-full bg-[#1c1c1c] border border-white/5 focus:border-[#00F0FF]/30 rounded-xl px-4 py-3 text-xs text-white outline-none transition-colors placeholder:text-neutral-600"
                  />
                </div>

                <button
                  type="submit"
                  disabled={authLoading}
                  className="w-full py-3 bg-[#00F0FF] hover:bg-[#00D0DF] text-black font-black uppercase text-[10px] tracking-widest transition-all rounded-xl cursor-pointer text-center disabled:opacity-50 disabled:cursor-not-allowed mt-2 shadow-[0_4px_15px_rgba(0,240,255,0.2)]"
                >
                  {authLoading ? 'Processando...' : authMode === 'login' ? 'Entrar' : 'Cadastrar'}
                </button>
              </form>

              <div className="text-center mt-1 border-t border-white/5 pt-4">
                {authMode === 'login' ? (
                  <p className="text-[11px] text-neutral-500">
                    Não tem conta?{' '}
                    <button 
                      onClick={() => {
                        setAuthMode('register');
                        setAuthError(null);
                      }} 
                      className="text-[#00F0FF] hover:underline font-bold cursor-pointer"
                    >
                      Criar uma conta
                    </button>
                  </p>
                ) : (
                  <p className="text-[11px] text-neutral-500">
                    Já tem uma conta?{' '}
                    <button 
                      onClick={() => {
                        setAuthMode('login');
                        setAuthError(null);
                      }} 
                      className="text-[#00F0FF] hover:underline font-bold cursor-pointer"
                    >
                      Fazer login
                    </button>
                  </p>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
