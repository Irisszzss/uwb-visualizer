import React, { useEffect, useState, useRef } from 'react';

const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";

const A1 = "1786";
const A2 = "1685";
const A3 = "1584";

// --- TUNING ---
const KALMAN_R = 6;
const KALMAN_Q = 0.005; // Slightly increased for better hover tracking
const UWB_LOCKED_Q = 0.0001; // Ultra-stiff for writing stability

const PEN_LENGTH_MM = 140;
const IMU_WRITING_GAIN = 4.0; 

const PRESSURE_MAX = 4095;
const PRESSURE_THRESHOLD = 200;

const lerp = (start, end, amt) => (1 - amt) * start + amt * end;

// --- FILTERS ---
class KalmanFilter {
  constructor(R = 1, Q = 1, A = 1, B = 0, C = 1) {
    this.R = R; this.Q = Q; this.A = A; this.C = C; this.B = B;
    this.cov = NaN; this.x = NaN;
  }
  filter(measurement) {
    if (isNaN(this.x)) { this.x = measurement; this.cov = this.R; return measurement; }
    const predX = this.A * this.x;
    const predCov = (this.A * this.cov * this.A) + this.Q;
    const K = predCov * this.C * (1 / ((this.C * predCov * this.C) + this.R));
    this.x = predX + K * (measurement - (this.C * predX));
    this.cov = predCov - (K * this.C * predCov);
    return this.x;
  }
}

// New filter specifically for removing IMU micro-tremors and jaggedness
class EMAFilter {
  constructor(alpha) { this.alpha = alpha; this.value = null; }
  filter(val) {
    if (this.value === null) { this.value = val; return val; }
    this.value = this.value + this.alpha * (val - this.value);
    return this.value;
  }
  reset() { this.value = null; }
}

export default function SmartStrokeDashboard() {
  const canvasRef = useRef(null);
  const cursorRef = useRef(null);
  
  // --- UI STATE ---
  const [isConnected, setIsConnected] = useState(false);
  const [isCalibrated, setIsCalibrated] = useState(false);
  const [calibStep, setCalibStep] = useState(0);
  const [anchorMap, setAnchorMap] = useState([]);
  
  const [canvasDim, setCanvasDim] = useState({ w: 800, h: 600 });
  const [pixelsPerMm, setPixelsPerMm] = useState(1);
  
  const [pages, setPages] = useState([[]]);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [selectedColor, setSelectedColor] = useState('#1e3a8a');
  const [toast, setToast] = useState({ show: false, message: '' });
  const [uiPenData, setUiPenData] = useState({ r: 1, i: 0, j: 0, k: 0, p: 0, down: false });

  // --- SENSOR REFS ---
  const sensorDataRef = useRef({
    links: [],
    pen: { r: 1, i: 0, j: 0, k: 0, down: false, p: 0, np: 0 }
  });
  
  const currentStrokePoints = useRef([]);
  const stabilizedPos = useRef({ x: 0, y: 0 });
  
  // --- FILTER REFS ---
  const kfX = useRef(new KalmanFilter(KALMAN_R, KALMAN_Q));
  const kfY = useRef(new KalmanFilter(KALMAN_R, KALMAN_Q));
  const imuXFilter = useRef(new EMAFilter(0.4)); // Smooths X jaggedness
  const imuYFilter = useRef(new EMAFilter(0.4)); // Smooths Y jaggedness
  
  const centerRef = useRef(null);
  const lastNpSignal = useRef(0);
  const requestRef = useRef();

  // --- MATH HELPERS ---
  const getYawPitch = (r, i, j, k) => {
    const qr = Number(r); const qi = Number(i); const qj = Number(j); const qk = Number(k);
    const sinp = 2 * (qr * qj - qk * qi);
    const pitch = Math.abs(sinp) >= 1 ? (Math.sign(sinp) * Math.PI) / 2 : Math.asin(sinp);
    const yaw = Math.atan2(2 * (qr * qk + qi * qj), 1 - 2 * (qj * qj + qk * qk));
    return { yaw, pitch };
  };

  const angleDiff = (a, b) => {
    let d = a - b;
    d = ((d + Math.PI) % (2 * Math.PI)) - Math.PI;
    return d;
  };

  const trilaterate = (d1, d2, d3, map) => {
    if (!map || map.length < 3) return null;
    const [x1, y1] = [map[0].x, map[0].y];
    const [x2, y2] = [map[1].x, map[1].y];
    const [x3, y3] = [map[2].x, map[2].y];
    const A = 2 * (x2 - x1);
    const B = 2 * (y2 - y1);
    const C = d1**2 - d2**2 - x1**2 + x2**2 - y1**2 + y2**2;
    const D = 2 * (x3 - x2);
    const E = 2 * (y3 - y2);
    const F = d2**2 - d3**2 - x2**2 + x3**2 - y2**2 + y3**2;
    const denom = E * A - B * D;
    if (Math.abs(denom) < 1e-6) return null;
    return { x: (C * E - F * B) / denom, y: (C * D - A * F) / (B * D - A * E) };
  };

  const triggerToast = (msg) => {
    setToast({ show: true, message: msg });
    setTimeout(() => setToast({ show: false, message: '' }), 3000);
  };

  const connectBLE = async () => {
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'UWB' }, { namePrefix: 'Smart' }],
        optionalServices: [SERVICE_UUID]
      });
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const char = await service.getCharacteristic(CHARACTERISTIC_UUID);
      await char.startNotifications();
      
      char.addEventListener('characteristicvaluechanged', (e) => {
        const value = new TextDecoder().decode(e.target.value);
        try {
          const parsed = JSON.parse(value);
          if (parsed.links) sensorDataRef.current.links = parsed.links;
          
          const pressureVal = parsed.p || 0;
          const isDown = (pressureVal > PRESSURE_THRESHOLD) || (parsed.d == 1); 
          
          const cleanPenData = {
            ...parsed,
            r: parseFloat(parsed.r || 1),
            i: parseFloat(parsed.i || 0),
            j: parseFloat(parsed.j || 0),
            k: parseFloat(parsed.k || 0),
            down: isDown
          };

          sensorDataRef.current.pen = { ...sensorDataRef.current.pen, ...cleanPenData };
          setUiPenData(prev => ({...prev, ...cleanPenData, down: isDown}));

          if (parsed.np === 1 && lastNpSignal.current === 0) {
            setPages(prev => [...prev, []]);
            setCurrentPageIndex(prev => prev + 1);
            triggerToast("New Page");
          }
          lastNpSignal.current = parsed.np || 0;
        } catch (err) {}
      });
      setIsConnected(true);
      triggerToast("Pen Connected");
    } catch (err) { 
      console.error(err);
      triggerToast("Bluetooth Error"); 
    }
  };

  const handleRecenter = () => {
    const { pen } = sensorDataRef.current;
    const { yaw, pitch } = getYawPitch(pen.r, pen.i, pen.j, pen.k);
    centerRef.current = { yaw, pitch };
    imuXFilter.current.reset();
    imuYFilter.current.reset();
    triggerToast("Orientation Reset");
  };

  // --- CALIBRATION ---
  const handleCalibration = () => {
    const getD = (addr) => {
      const link = sensorDataRef.current.links.find(l => l.A == addr);
      return parseFloat(link?.R || 0) * 1000;
    };
    const d1 = getD(A1), d2 = getD(A2), d3 = getD(A3);

    if (calibStep === 0) {
      setAnchorMap([{ x: 0, y: 0 }, { d1_a2: d2, d1_a3: d3 }]);
      setCalibStep(1);
      triggerToast("Origin Fixed. Tap Anchor 2.");
    } else {
      const { d1_a2, d1_a3 } = anchorMap[1];
      const p_a1 = { x: 0, y: 0 };
      const p_a2 = { x: d1_a2, y: 0 }; 
      let cosA = (d1_a3**2 + d1_a2**2 - d3**2) / (2 * d1_a3 * d1_a2);
      const p_a3 = { x: d1_a3 * cosA, y: d1_a3 * Math.sin(Math.acos(Math.max(-1, Math.min(1, cosA)))) };
      
      const realWidthMM = p_a2.x; 
      const realHeightMM = Math.abs(p_a3.y);

      const targetCanvasWidthPX = 1000; 
      const ratio = targetCanvasWidthPX / realWidthMM;
      const targetCanvasHeightPX = realHeightMM * ratio;

      setCanvasDim({ w: targetCanvasWidthPX, h: targetCanvasHeightPX });
      setPixelsPerMm(ratio); 

      setAnchorMap([p_a1, p_a2, p_a3]);
      setIsCalibrated(true);
      setCalibStep(2);
      triggerToast(`Calibrated! Scale: ${ratio.toFixed(2)} px/mm`);
    }
  };

  // --- RENDER LOOP ---
  const animate = () => {
    if (isCalibrated && canvasRef.current && cursorRef.current && anchorMap.length === 3) {
      const ctx = canvasRef.current.getContext('2d');
      const cCtx = cursorRef.current.getContext('2d');
      const { links, pen } = sensorDataRef.current;
      
      const getD = (addr) => {
        const link = links.find(l => l.A == addr);
        return parseFloat(link?.R || 0) * 1000;
      };
      
      // 1. UWB Calculation
      const worldPos = trilaterate(getD(A1), getD(A2), getD(A3), anchorMap);

      if (worldPos) {
        // 2. Convert to Pixels
        const rawUwbX = worldPos.x * pixelsPerMm;
        const rawUwbY = worldPos.y * pixelsPerMm;

        // --- FIX: SPATIAL STICKY ANCHORING ---
        // Calculate how far the raw UWB is from our current stable cursor
        const currentX = kfX.current.x || rawUwbX;
        const currentY = kfY.current.x || rawUwbY;
        const distFromStable = Math.hypot(rawUwbX - currentX, rawUwbY - currentY);
        const distMm = distFromStable / pixelsPerMm;

        // Determine how "stiff" the UWB should be
        let dynamicQ;
        if (pen.down) {
            dynamicQ = UWB_LOCKED_Q; // 1. Writing: Ultra stiff, locked in place
        } else if (distMm < 25) {
            dynamicQ = 0.0005;       // 2. Hovering near last stroke (like the 'k'): Keep it very stiff!
        } else {
            dynamicQ = KALMAN_Q;     // 3. Moving far away (new word): Let it catch up quickly
        }

        kfX.current.Q = dynamicQ;
        kfY.current.Q = dynamicQ;

        // 3. Filter UWB
        const stableX = kfX.current.filter(rawUwbX);
        const stableY = kfY.current.filter(rawUwbY);

        // 4. IMU Logic
        const { yaw, pitch } = getYawPitch(pen.r, pen.i, pen.j, pen.k);
        
        // Reset anchor and clear internal filters when lifting pen
        if (!centerRef.current || !pen.down) {
          centerRef.current = { yaw, pitch };
          imuXFilter.current.reset();
          imuYFilter.current.reset();
        }

        const dYaw = angleDiff(yaw, centerRef.current.yaw);
        const dPitch = angleDiff(pitch, centerRef.current.pitch);

        let rawOffsetX = -Math.sin(dYaw) * PEN_LENGTH_MM * IMU_WRITING_GAIN * pixelsPerMm;
        let rawOffsetY = -Math.sin(dPitch) * PEN_LENGTH_MM * IMU_WRITING_GAIN * pixelsPerMm;

        // Smooth out the high-frequency IMU noise before it reaches the canvas
        const pixelOffsetX = imuXFilter.current.filter(rawOffsetX);
        const pixelOffsetY = imuYFilter.current.filter(rawOffsetY);

        // 5. Target Calculation (Fusion)
        const targetX = stableX + pixelOffsetX;
        const targetY = stableY + pixelOffsetY;
        
        // 6. Fluid Stabilization
        const smoothingAlpha = pen.down ? 0.35 : 0.7; // Smooth ink, fast hover
        let finalX, finalY;

        if (stabilizedPos.current.x === 0 && stabilizedPos.current.y === 0) {
           finalX = targetX; finalY = targetY; // Initial snap
        } else {
           finalX = lerp(stabilizedPos.current.x, targetX, smoothingAlpha);
           finalY = lerp(stabilizedPos.current.y, targetY, smoothingAlpha);
        }

        stabilizedPos.current = { x: finalX, y: finalY };

        const x = Math.max(0, Math.min(finalX, canvasDim.w));
        const y = Math.max(0, Math.min(finalY, canvasDim.h));

        // 7. Draw
        if (pen.down) {
          ctx.strokeStyle = selectedColor;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          const pressureWeight = pen.p / PRESSURE_MAX;
          ctx.lineWidth = 1 + (pressureWeight * 3); 

          currentStrokePoints.current.push({ x, y, p: pen.p, color: selectedColor });

          const points = currentStrokePoints.current;
          if (points.length > 2) {
            const last = points[points.length - 1];
            const prev = points[points.length - 2];
            const prev2 = points[points.length - 3];
            
            const midX = (prev.x + last.x) / 2;
            const midY = (prev.y + last.y) / 2;
            const prevMidX = (prev2.x + prev.x) / 2;
            const prevMidY = (prev2.y + prev.y) / 2;

            ctx.beginPath();
            ctx.moveTo(prevMidX, prevMidY);
            ctx.quadraticCurveTo(prev.x, prev.y, midX, midY);
            ctx.stroke();
          } else if (points.length === 2) {
             ctx.beginPath();
             ctx.moveTo(points[0].x, points[0].y);
             ctx.lineTo(points[1].x, points[1].y);
             ctx.stroke();
          }
        } else {
          if (currentStrokePoints.current.length > 0) {
            const strokeCopy = [...currentStrokePoints.current];
            setPages(prev => {
              const updated = [...prev];
              updated[currentPageIndex] = [...(updated[currentPageIndex] || []), { points: strokeCopy, color: selectedColor }];
              return updated;
            });
            currentStrokePoints.current = [];
          }
        }

        // 8. Cursor
        cCtx.clearRect(0, 0, canvasDim.w, canvasDim.h);
        
        cCtx.beginPath();
        cCtx.arc(stableX, stableY, 3, 0, Math.PI * 2);
        cCtx.fillStyle = '#94a3b8'; 
        cCtx.fill();

        cCtx.beginPath();
        cCtx.moveTo(stableX, stableY);
        cCtx.lineTo(x, y);
        cCtx.strokeStyle = 'rgba(0,0,0,0.15)';
        cCtx.stroke();
        
        cCtx.beginPath();
        const cursorRadius = pen.down ? 3 : 5; 
        cCtx.arc(x, y, cursorRadius, 0, Math.PI * 2);
        cCtx.fillStyle = pen.down ? selectedColor : '#f97316'; 
        cCtx.fill();
        cCtx.strokeStyle = 'white'; 
        cCtx.lineWidth = 2; 
        cCtx.stroke();
      }
    }
    requestRef.current = requestAnimationFrame(animate);
  };

  useEffect(() => {
    requestRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(requestRef.current);
  }, [isCalibrated, canvasDim, selectedColor, currentPageIndex, anchorMap, pixelsPerMm]); 

  // Page Redraw Logic
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas && isCalibrated) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvasDim.w, canvasDim.h);
      const pageStrokes = pages[currentPageIndex] || [];
      
      pageStrokes.forEach(stroke => {
        if (!stroke.points || stroke.points.length < 2) return;
        ctx.beginPath();
        ctx.strokeStyle = stroke.color;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length - 1; i++) {
           const p1 = stroke.points[i];
           const p2 = stroke.points[i + 1];
           const midX = (p1.x + p2.x) / 2;
           const midY = (p1.y + p2.y) / 2;
           const pWeight = p1.p / PRESSURE_MAX;
           ctx.lineWidth = 1 + (pWeight * 3);
           ctx.quadraticCurveTo(p1.x, p1.y, midX, midY);
        }
        const last = stroke.points[stroke.points.length-1];
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
      });
    }
  }, [currentPageIndex, isCalibrated, canvasDim, pages]);

  return (
    <div className="flex h-screen w-screen bg-slate-200 overflow-hidden font-['Poppins'] select-none">
      <aside className="w-72 bg-white border-r border-slate-300 p-6 flex flex-col shadow-lg z-50 overflow-y-auto">
        <h1 className="text-2xl font-black text-slate-900 mb-8 tracking-tighter italic">SMART<span className="text-blue-600">STROKE</span></h1>

        <div className="space-y-4">
          <button onClick={connectBLE} className={`w-full p-4 rounded-2xl font-bold transition-all ${isConnected ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400 border border-slate-200'}`}>
            {isConnected ? '● CONNECTED' : 'CONNECT PEN'}
          </button>

          {isConnected && (
            <button onClick={handleRecenter} className="w-full p-3 bg-blue-50 text-blue-700 rounded-xl font-bold text-xs border border-blue-200 hover:bg-blue-100">
               RESET ORIENTATION
            </button>
          )}

          <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200">
             <h3 className="text-[10px] font-black text-slate-500 uppercase mb-3 text-center">Surface Mapping</h3>
             {!isCalibrated ? (
               <button onClick={handleCalibration} disabled={!isConnected} className="w-full p-3 bg-slate-900 text-white rounded-xl font-bold text-xs hover:bg-black">
                 {calibStep === 0 ? "1. CALIBRATE ORIGIN" : "2. CALIBRATE WIDTH"}
               </button>
             ) : (
               <div className="text-center">
                 <div className="text-[10px] text-blue-600 font-bold mb-1 uppercase">
                    Scale: {pixelsPerMm.toFixed(3)} px/mm <br/>
                    Canvas: {canvasDim.w}x{Math.round(canvasDim.h)}px
                 </div>
                 <button onClick={() => {setIsCalibrated(false); setCalibStep(0);}} className="text-[10px] text-slate-400 underline">Reset</button>
               </div>
             )}
          </div>

          <div className="bg-slate-900 p-4 rounded-2xl flex flex-col items-center">
             <h3 className="text-[10px] font-black text-slate-500 uppercase mb-4">IMU Telemetry</h3>
             <div className="w-16 h-16 bg-blue-600 rounded-lg shadow-2xl transition-transform duration-100 ease-linear border border-white/20"
                  style={{ transform: `rotateX(${uiPenData.j * 90}deg) rotateY(${uiPenData.i * 90}deg)` }} />
             <div className="mt-4 w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                <div className="bg-blue-400 h-full transition-all duration-75" 
                     style={{ width: `${(uiPenData.p / PRESSURE_MAX) * 100}%` }} />
             </div>
          </div>
          <div className="flex justify-center gap-3">
             {['#1e3a8a', '#f97316', '#ef4444', '#22c55e', '#000000'].map(c => (
               <button key={c} onClick={() => setSelectedColor(c)} className={`w-8 h-8 rounded-full border-4 ${selectedColor === c ? 'border-blue-200 scale-125' : 'border-transparent'}`} style={{backgroundColor: c}} />
             ))}
           </div>
        </div>
      </aside>

      <main className="flex-1 relative flex flex-col items-center justify-center p-12 bg-slate-100 overflow-auto">
        <div className="relative bg-white shadow-[0_0_60px_rgba(0,0,0,0.15)] border-[12px] border-slate-900 flex-shrink-0" 
             style={{ 
               width: `${canvasDim.w}px`, 
               height: `${canvasDim.h}px`, 
               backgroundImage: `radial-gradient(#e2e8f0 1.5px, transparent 1.5px)`,
               backgroundSize: '30px 30px' 
             }}>
          
          <canvas ref={canvasRef} width={canvasDim.w} height={canvasDim.h} className="absolute inset-0" />
          <canvas ref={cursorRef} width={canvasDim.w} height={canvasDim.h} className="absolute inset-0 z-10 pointer-events-none" />
          
          {!isCalibrated && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/95 z-20">
               <div className="p-12 border-4 border-slate-900 text-center">
                 <div className="text-slate-900 font-black text-4xl uppercase tracking-tighter mb-4">Surface Locked</div>
                 <p className="text-slate-500">Run calibration to set workspace dimensions</p>
               </div>
            </div>
          )}
        </div>
      </main>
      
      {toast.show && (
        <div className="fixed bottom-8 right-8 bg-slate-900 text-white px-6 py-3 rounded-full font-bold shadow-2xl z-[100] animate-in fade-in slide-in-from-bottom-4">
          {toast.message}
        </div>
      )}
    </div>
  );
}