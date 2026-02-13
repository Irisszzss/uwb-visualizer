import React, { useState, useEffect, useMemo, useRef } from 'react';

// --- BLE CONFIGURATION ---
const BLE_SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const BLE_CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";

const ANCHOR_1_ADDR = "1786";
const ANCHOR_2_ADDR = "1685";
const ANCHOR_3_ADDR = "1584";

// --- FIXED DIMENSIONS ---
const FIXED_WIDTH = 1000;
const FIXED_HEIGHT = 600;

const MAX_CANVAS_PADDING = 50;
const MIN_CANVAS_PADDING = 10;
const PADDING_PERCENT = 0.05;

const SMOOTHING_ALPHA = 0.6;
const MOVEMENT_THRESHOLD_PX = 0.5;

// --- STYLES ---
const styles = {
  container: { minHeight: '100vh', backgroundColor: '#f1f5f9', fontFamily: 'sans-serif', padding: '20px' },
  header: { borderBottom: '1px solid #e2e8f0', paddingBottom: '20px', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  card: { backgroundColor: 'white', padding: '30px', borderRadius: '20px', boxShadow: '0 10px 25px rgba(0,0,0,0.1)', maxWidth: '500px', margin: '0 auto' },
  button: { width: '100%', padding: '12px', background: 'linear-gradient(to right, #3b82f6, #4f46e5)', color: 'white', border: 'none', borderRadius: '10px', cursor: 'pointer', fontWeight: 'bold' },
  canvasContainer: { 
    width: `${FIXED_WIDTH}px`, 
    height: `${FIXED_HEIGHT}px`, 
    backgroundColor: 'white', 
    borderRadius: '12px', 
    boxShadow: '0 4px 6px rgba(0,0,0,0.1)', 
    border: '2px solid #e2e8f0', 
    position: 'relative', 
    overflow: 'hidden',
    margin: '0 auto' 
  },
  debugBox: { marginTop: '15px', padding: '15px', backgroundColor: '#1e293b', color: '#f8fafc', borderRadius: '8px', fontSize: '12px', fontFamily: 'monospace', overflow: 'auto', maxHeight: '200px' }
};

function useUwbData() {
  const [links, setLinks] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const bluetoothDeviceRef = useRef(null);

  const connectBluetooth = async () => {
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'UWB' }, { services: [BLE_SERVICE_UUID] }],
        optionalServices: [BLE_SERVICE_UUID]
      });

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(BLE_SERVICE_UUID);
      const characteristic = await service.getCharacteristic(BLE_CHARACTERISTIC_UUID);

      bluetoothDeviceRef.current = device;
      setIsConnected(true);

      await characteristic.startNotifications();
      characteristic.addEventListener('characteristicvaluechanged', (event) => {
        const decoder = new TextDecoder('utf-8');
        const jsonString = decoder.decode(event.target.value);
        try {
          const data = JSON.parse(jsonString);
          if (data.links) setLinks(data.links);
        } catch (error) {
          console.error('BLE JSON Parse Error:', error);
        }
      });

      device.addEventListener('gattserverdisconnected', () => {
        setIsConnected(false);
      });

    } catch (error) {
      console.error('Bluetooth Connection Failed:', error);
      setIsConnected(false);
    }
  };

  return { links, isConnected, connectBluetooth };
}

function trilaterate(d1, d2, d3, anchorMap) {
  if (!anchorMap || anchorMap.length < 3) return null;
  const [x1, y1] = [anchorMap[0].x, anchorMap[0].y];
  const [x2, y2] = [anchorMap[1].x, anchorMap[1].y];
  const [x3, y3] = [anchorMap[2].x, anchorMap[2].y];
  const A = 2 * (x2 - x1);
  const B = 2 * (y2 - y1);
  const C = d1 * d1 - d2 * d2 - x1 * x1 + x2 * x2 - y1 * y1 + y2 * y2;
  const D = 2 * (x3 - x2);
  const E = 2 * (y3 - y2);
  const F = d2 * d2 - d3 * d3 - x2 * x2 + x3 * x3 - y2 * y2 + y3 * y3;
  const denom = E * A - B * D;
  if (Math.abs(denom) < 1e-6) return null;
  const x = (C * E - F * B) / denom;
  const y = (C * D - A * F) / (B * D - A * E);
  return { x, y };
}

function CalibrationPage({ liveData, anchorAddrs, onCalibrationComplete }) {
  const [step, setStep] = useState('step1');
  const [measuredDists, setMeasuredDists] = useState({ d1_a2: null, d1_a3: null, d2_a3: null });
  const { ANCHOR_1_ADDR, ANCHOR_2_ADDR } = anchorAddrs;

  const handleRecordStep1 = () => {
    if (!liveData?.d2 || !liveData?.d3) {
      alert("No distance data. Check anchors.");
      return;
    }
    setMeasuredDists({ d1_a2: liveData.d2, d1_a3: liveData.d3, d2_a3: null });
    setStep('step2');
  };

  const handleRecordStep2 = () => {
    if (!liveData?.d3) {
      alert("No distance to Anchor 3.");
      return;
    }
    const finalDists = { ...measuredDists, d2_a3: liveData.d3 };
    const { d1_a2, d1_a3, d2_a3 } = finalDists;
    const p_a1 = { x: 0, y: 0 };
    const p_a2 = { x: d1_a2, y: 0 };
    let cosA = (d1_a3**2 + d1_a2**2 - d2_a3**2) / (2 * d1_a3 * d1_a2);
    cosA = Math.max(-1, Math.min(1, cosA)); 
    const p_a3 = { x: d1_a3 * Math.cos(Math.acos(cosA)), y: d1_a3 * Math.sin(Math.acos(cosA)) };
    onCalibrationComplete([p_a1, p_a2, p_a3]);
  };

  return (
    <div style={styles.card}>
      <h2 style={{ textAlign: 'center' }}>Calibration</h2>
      <p style={{ color: '#64748b', marginBottom: '20px' }}>
        Step: {step === 'step1' ? `Place tag on Anchor 1 (${ANCHOR_1_ADDR})` : `Place tag on Anchor 2 (${ANCHOR_2_ADDR})`}
      </p>
      <button 
        style={styles.button} 
        onClick={step === 'step1' ? handleRecordStep1 : handleRecordStep2}
      >
        Record Distances
      </button>
    </div>
  );
}

function LiveCanvas({ smoothingAlpha, moveThreshold, liveData, anchorMap, isCalibrated }) {
  const canvasRef = useRef(null);
  const strokesRef = useRef([[]]);
  const smoothRef = useRef({ x: 0, y: 0 });
  const [isSmootherInitialized, setIsSmootherInitialized] = useState(false);

  // MODIFIED viewTransform for Rectangular Logic
  const viewTransform = useMemo(() => {
    const dynamicPadding = Math.max(MIN_CANVAS_PADDING, Math.min(MAX_CANVAS_PADDING, FIXED_WIDTH * PADDING_PERCENT));
    if (!isCalibrated || anchorMap.length < 3) return { pixelsPerMm: 0.1, originX: dynamicPadding, originY: dynamicPadding, worldWidth: 1000, worldHeight: 600 };
    
    const [p_a1, p_a2, p_a3] = anchorMap;
    
    // Rectangular width defined by distance A1 -> A2 (p_a2.x)
    // Rectangular height defined by vertical distance to A3 (p_a3.y)
    const worldWidth = p_a2.x;
    const worldHeight = p_a3.y;

    const scale = Math.min((FIXED_WIDTH - 2 * dynamicPadding) / worldWidth, (FIXED_HEIGHT - 2 * dynamicPadding) / worldHeight);
    
    return { 
      pixelsPerMm: scale, 
      originX: (FIXED_WIDTH - worldWidth * scale) / 2, 
      originY: (FIXED_HEIGHT - worldHeight * scale) / 2,
      worldWidth,
      worldHeight
    };
  }, [anchorMap, isCalibrated]);

  const worldToScreen = (p) => ({
    x: p.x * viewTransform.pixelsPerMm + viewTransform.originX,
    y: p.y * viewTransform.pixelsPerMm + viewTransform.originY,
  });

  const anchorPixels = useMemo(() => anchorMap.map(worldToScreen), [anchorMap, viewTransform]);

  const draw = () => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, FIXED_WIDTH, FIXED_HEIGHT);
    
    if (isCalibrated) {
      // Draw Writable Rect Boundary
      ctx.strokeStyle = '#e2e8f0';
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(viewTransform.originX, viewTransform.originY, viewTransform.worldWidth * viewTransform.pixelsPerMm, viewTransform.worldHeight * viewTransform.pixelsPerMm);
      ctx.setLineDash([]);

      anchorPixels.forEach((a, i) => {
        ctx.beginPath(); ctx.arc(a.x, a.y, 6, 0, Math.PI * 2); ctx.fillStyle = '#22c55e'; ctx.fill();
        ctx.fillStyle = 'black'; ctx.fillText(`A${i+1}`, a.x + 8, a.y);
      });
    }
    
    ctx.lineWidth = 3; ctx.strokeStyle = 'magenta'; ctx.lineCap = 'round';
    strokesRef.current.forEach(s => {
      if (s.length < 2) return;
      ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y);
      for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y);
      ctx.stroke();
    });
  };

  useEffect(() => {
    if (!isCalibrated || !liveData?.pos_mm) { draw(); return; }
    
    const pos_px = worldToScreen(liveData.pos_mm);
    
    // RECTANGULAR CHECK: Replace pointInTriangle with X/Y Bounds
    const isInside = 
        liveData.pos_mm.x >= 0 && 
        liveData.pos_mm.x <= viewTransform.worldWidth &&
        liveData.pos_mm.y >= 0 &&
        liveData.pos_mm.y <= viewTransform.worldHeight;

    if (!isSmootherInitialized) { smoothRef.current = pos_px; setIsSmootherInitialized(true); }
    const old = smoothRef.current;
    smoothRef.current = { x: smoothingAlpha * pos_px.x + (1 - smoothingAlpha) * old.x, y: smoothingAlpha * pos_px.y + (1 - smoothingAlpha) * old.y };
    
    if (Math.hypot(smoothRef.current.x - old.x, smoothRef.current.y - old.y) > moveThreshold && isInside) {
      strokesRef.current[strokesRef.current.length - 1].push({ ...smoothRef.current });
    }
    draw();
  }, [liveData, isCalibrated]);

  return (
    <div style={styles.canvasContainer}>
      <canvas ref={canvasRef} width={FIXED_WIDTH} height={FIXED_HEIGHT} />
      <button onClick={() => { strokesRef.current = [[]]; draw(); }} style={{ position: 'absolute', bottom: '10px', right: '10px' }}>Clear</button>
    </div>
  );
}

export default function App() {
  const { links, isConnected, connectBluetooth } = useUwbData();
  const [isCalibrated, setIsCalibrated] = useState(false);
  const [anchorMap, setAnchorMap] = useState([]);

  const liveData = useMemo(() => {
    const getD = (addr) => parseFloat(links.find(l => l.A === addr)?.R) * 1000;
    const d = { d1: getD(ANCHOR_1_ADDR), d2: getD(ANCHOR_2_ADDR), d3: getD(ANCHOR_3_ADDR) };
    if (!d.d1 || !d.d2 || !d.d3 || !isCalibrated) return { ...d, pos_mm: null };
    return { ...d, pos_mm: trilaterate(d.d1, d.d2, d.d3, anchorMap) };
  }, [links, anchorMap, isCalibrated]);

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={{flex: 1}}>
          <h1 style={{margin: 0}}>UWB Whiteboard</h1>
          <p style={{ color: isConnected ? 'green' : 'red', margin: 0 }}>{isConnected ? '● Connected' : '○ Disconnected'}</p>
        </div>
        {!isConnected && (
           <button style={{...styles.button, width: 'auto', padding: '10px 20px'}} onClick={connectBluetooth}>
             Connect Bluetooth
           </button>
        )}
      </header>
      {!isCalibrated ? (
        <CalibrationPage liveData={liveData} anchorAddrs={{ ANCHOR_1_ADDR, ANCHOR_2_ADDR }} onCalibrationComplete={(map) => { setAnchorMap(map); setIsCalibrated(true); }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
          <LiveCanvas smoothingAlpha={SMOOTHING_ALPHA} moveThreshold={MOVEMENT_THRESHOLD_PX} liveData={liveData} anchorMap={anchorMap} isCalibrated={isCalibrated} />
          <div style={{ ...styles.debugBox, width: `${FIXED_WIDTH}px` }}>
            <pre>{JSON.stringify({ liveData, links }, null, 2)}</pre>
            <button onClick={() => setIsCalibrated(false)}>Reset Calibration</button>
          </div>
        </div>
      )}
      <style>{`
        body { margin: 0; }
        button { padding: 8px 16px; cursor: pointer; border-radius: 4px; border: 1px solid #ccc; background: white; }
        button:hover { background: #f8fafc; }
      `}</style>
    </div>
  );
}