import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Camera, ChevronLeft, FolderOpen, Image, Plus, Trash2,
  Download, SwitchCamera, Sliders, X, RefreshCw
} from 'lucide-react'
import confetti from 'canvas-confetti'
import EXIF from 'exif-js'

// ─── Types ───────────────────────────────────────────────────────────────────

interface OverlayTransform {
  x: number
  y: number
  scale: number
  rotate: number
}

interface FilterSettings {
  brightness: number
  contrast: number
  saturate: number
  temperature: number
}

interface ExifData {
  focalLength?: number
  focalLengthIn35mm?: number
  lensModel?: string
  digitalZoomRatio?: number
}

interface PhotoPair {
  id: string
  oldPhotoUrl: string
  newPhotoUrl: string
  timestamp: number
  exif?: ExifData
  cameraFilters: FilterSettings
  overlayFilters: FilterSettings
  overlayTransform: OverlayTransform
  label?: string
  projectId?: string
}

interface Project {
  id: string
  name: string
  basePhotoUrl: string
  pairs: PhotoPair[]
  exif?: ExifData
  createdAt: number
}

type View = 'home' | 'camera' | 'gallery' | 'projects' | 'project-detail' | 'pair-detail'

const defaultFilters: FilterSettings = { brightness: 100, contrast: 100, saturate: 100, temperature: 0 }
const defaultTransform: OverlayTransform = { x: 0, y: 0, scale: 1, rotate: 0 }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function filtersToCSS(f: FilterSettings) {
  return `brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturate}%) hue-rotate(${f.temperature}deg)`
}

function calcAccuracy(t: OverlayTransform): number {
  const normX = Math.min(Math.abs(t.x) / 50, 1) * 25
  const normY = Math.min(Math.abs(t.y) / 50, 1) * 25
  const normScale = Math.min(Math.abs(t.scale - 1) / 0.2, 1) * 25
  const normRot = Math.min(Math.abs(t.rotate) / 5, 1) * 25
  return Math.max(0, Math.round(100 - normX - normY - normScale - normRot))
}

function extractExif(file: File): Promise<ExifData> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({}), 1500)
    EXIF.getData(file as unknown as string, function (this: unknown) {
      clearTimeout(timeout)
      const self = this as Record<string, unknown>
      resolve({
        focalLength: EXIF.getTag(self, 'FocalLength') as number | undefined,
        focalLengthIn35mm: EXIF.getTag(self, 'FocalLengthIn35mmFilm') as number | undefined,
        lensModel: EXIF.getTag(self, 'LensModel') as string | undefined,
        digitalZoomRatio: EXIF.getTag(self, 'DigitalZoomRatio') as number | undefined,
      })
    })
  })
}

function loadPairs(): PhotoPair[] {
  try { return JSON.parse(localStorage.getItem('rephoto_pairs') || '[]') } catch { return [] }
}
function savePairs(pairs: PhotoPair[]) {
  localStorage.setItem('rephoto_pairs', JSON.stringify(pairs))
}
function loadProjects(): Project[] {
  try { return JSON.parse(localStorage.getItem('rephoto_projects') || '[]') } catch { return [] }
}
function saveProjects(projects: Project[]) {
  localStorage.setItem('rephoto_projects', JSON.stringify(projects))
}

// ─── Before/After Slider ─────────────────────────────────────────────────────

function BeforeAfterSlider({ oldUrl, newUrl }: { oldUrl: string; newUrl: string }) {
  const [pos, setPos] = useState(50)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const update = (clientX: number) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const pct = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100))
    setPos(pct)
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full aspect-[4/3] overflow-hidden rounded-xl select-none touch-none"
      onMouseDown={() => { dragging.current = true }}
      onMouseMove={e => { if (dragging.current) update(e.clientX) }}
      onMouseUp={() => { dragging.current = false }}
      onMouseLeave={() => { dragging.current = false }}
      onTouchMove={e => update(e.touches[0].clientX)}
    >
      <img src={newUrl} className="absolute inset-0 w-full h-full object-cover" alt="Jetzt" />
      <div className="absolute inset-0 overflow-hidden" style={{ width: `${pos}%` }}>
        <img src={oldUrl} className="absolute inset-0 w-full h-full object-cover" style={{ width: `${10000 / pos}%` }} alt="Damals" />
      </div>
      <div className="absolute top-0 bottom-0 w-0.5 bg-white shadow-lg" style={{ left: `${pos}%` }}>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 flex items-center justify-center shadow-xl">
          <RefreshCw size={14} className="text-gray-800" />
        </div>
      </div>
      <div className="absolute top-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded-full">Damals</div>
      <div className="absolute top-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded-full">Heute</div>
    </div>
  )
}

// ─── Camera View ─────────────────────────────────────────────────────────────

function CameraView({
  basePhoto,
  baseExif,
  onSave,
  onBack,
  projectId,
}: {
  basePhoto: string
  baseExif?: ExifData
  onSave: (pair: PhotoPair) => void
  onBack: () => void
  projectId?: string
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [camIndex, setCamIndex] = useState(0)
  const [overlayTransform, setOverlayTransform] = useState<OverlayTransform>(defaultTransform)
  const [overlayOpacity, setOverlayOpacity] = useState(60)
  const [cameraFilters, setCameraFilters] = useState<FilterSettings>(defaultFilters)
  const [overlayFilters, setOverlayFilters] = useState<FilterSettings>(defaultFilters)
  const [showPanel, setShowPanel] = useState(false)
  const [panelTab, setPanelTab] = useState<'controls' | 'camera-filters' | 'overlay-filters'>('controls')
  const [filterMode, setFilterMode] = useState<'normal' | 'difference' | 'invert' | 'edges'>('normal')
  const accuracy = calcAccuracy(overlayTransform)

  // Pinch / drag state
  const touchState = useRef<{ lastDist: number; lastAngle: number; startTransform: OverlayTransform } | null>(null)
  const dragState = useRef<{ startX: number; startY: number; startTX: number; startTY: number } | null>(null)

  const startCamera = useCallback(async (deviceId?: string) => {
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop())
    try {
      const constraints: MediaStreamConstraints = {
        video: deviceId
          ? { deviceId: { exact: deviceId } }
          : { facingMode: 'environment' }
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCameraActive(true)
      const devices = await navigator.mediaDevices.enumerateDevices()
      setCameras(devices.filter(d => d.kind === 'videoinput'))
    } catch (e) {
      console.error('Camera error', e)
    }
  }, [])

  useEffect(() => {
    startCamera()
    return () => { streamRef.current?.getTracks().forEach(t => t.stop()) }
  }, [startCamera])

  const switchCamera = async () => {
    const next = (camIndex + 1) % Math.max(cameras.length, 1)
    setCamIndex(next)
    if (cameras[next]) await startCamera(cameras[next].deviceId)
  }

  // Touch: 2 fingers = pinch/rotate, 1 finger = drag overlay
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      touchState.current = {
        lastDist: Math.hypot(dx, dy),
        lastAngle: Math.atan2(dy, dx),
        startTransform: { ...overlayTransform },
      }
    } else if (e.touches.length === 1) {
      dragState.current = {
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        startTX: overlayTransform.x,
        startTY: overlayTransform.y,
      }
    }
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    e.preventDefault()
    if (e.touches.length === 2 && touchState.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.hypot(dx, dy)
      const angle = Math.atan2(dy, dx)
      const scaleDelta = dist / touchState.current.lastDist
      const angleDelta = (angle - touchState.current.lastAngle) * (180 / Math.PI)
      setOverlayTransform(prev => ({
        ...prev,
        scale: Math.max(0.1, Math.min(5, prev.scale * scaleDelta)),
        rotate: prev.rotate + angleDelta,
      }))
      touchState.current.lastDist = dist
      touchState.current.lastAngle = angle

      // Also apply zoom to camera
      if (streamRef.current) {
        const track = streamRef.current.getVideoTracks()[0]
        const capabilities = track.getCapabilities() as { zoom?: { min: number; max: number } }
        if (capabilities.zoom) {
          const currentConstraints = track.getSettings() as { zoom?: number }
          const currentZoom = currentConstraints.zoom ?? 1
          const newZoom = Math.max(capabilities.zoom.min, Math.min(capabilities.zoom.max, currentZoom * scaleDelta))
          track.applyConstraints({ advanced: [{ zoom: newZoom } as MediaTrackConstraintSet] }).catch(() => {})
        }
      }
    } else if (e.touches.length === 1 && dragState.current) {
      const dx = e.touches[0].clientX - dragState.current.startX
      const dy = e.touches[0].clientY - dragState.current.startY
      setOverlayTransform(prev => ({
        ...prev,
        x: dragState.current!.startTX + dx,
        y: dragState.current!.startTY + dy,
      }))
    }
  }

  const handleTouchEnd = () => {
    touchState.current = null
    dragState.current = null
  }

  const capturePhoto = async () => {
    if (!videoRef.current) return
    const canvas = document.createElement('canvas')
    const video = videoRef.current
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')!
    ctx.filter = filtersToCSS(cameraFilters)
    ctx.drawImage(video, 0, 0)
    const newPhotoUrl = canvas.toDataURL('image/jpeg', 0.92)

    confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } })

    const pair: PhotoPair = {
      id: Date.now().toString(),
      oldPhotoUrl: basePhoto,
      newPhotoUrl,
      timestamp: Date.now(),
      exif: baseExif,
      cameraFilters,
      overlayFilters,
      overlayTransform,
      projectId,
    }
    onSave(pair)
  }

  const overlayStyle: React.CSSProperties = {
    transform: `translate(${overlayTransform.x}px, ${overlayTransform.y}px) scale(${overlayTransform.scale}) rotate(${overlayTransform.rotate}deg)`,
    opacity: overlayOpacity / 100,
    filter: filterMode === 'invert' ? 'invert(1)' : filterMode === 'difference' ? filtersToCSS(overlayFilters) : filtersToCSS(overlayFilters),
    mixBlendMode: filterMode === 'difference' ? 'difference' : 'normal',
  }

  const accuracyColor = accuracy >= 80 ? 'text-emerald-400' : accuracy >= 50 ? 'text-yellow-400' : 'text-red-400'

  return (
    <div className="fixed inset-0 bg-black flex flex-col">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/70 to-transparent">
        <button onClick={onBack} className="p-2 rounded-full bg-white/10 backdrop-blur-sm">
          <ChevronLeft size={20} className="text-white" />
        </button>
        <div className="flex items-center gap-2">
          <span className="text-white/60 text-sm">Genauigkeit</span>
          <span className={`text-lg font-bold ${accuracyColor}`}>{accuracy}%</span>
        </div>
        <div className="flex items-center gap-2">
          {cameraActive && <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />}
          <button onClick={switchCamera} className="p-2 rounded-full bg-white/10 backdrop-blur-sm">
            <SwitchCamera size={18} className="text-white" />
          </button>
        </div>
      </div>

      {/* Camera + Overlay */}
      <div
        className="flex-1 relative overflow-hidden touch-none"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          playsInline
          muted
          style={{ filter: filtersToCSS(cameraFilters) }}
        />
        {basePhoto && (
          <img
            src={basePhoto}
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            style={overlayStyle}
            alt="Overlay"
          />
        )}
      </div>

      {/* Bottom Controls */}
      <div className="absolute bottom-0 left-0 right-0 z-20">
        <div className="flex items-center justify-between px-6 pb-8 pt-4 bg-gradient-to-t from-black/80 to-transparent">
          <button
            onClick={() => setShowPanel(!showPanel)}
            className="p-3 rounded-full bg-white/10 backdrop-blur-sm"
          >
            <Sliders size={22} className="text-white" />
          </button>

          {/* Shutter */}
          <button
            onClick={capturePhoto}
            className="w-18 h-18 rounded-full border-4 border-white bg-white/20 backdrop-blur-sm flex items-center justify-center active:scale-95 transition-transform"
            style={{ width: 72, height: 72 }}
          >
            <div className="w-14 h-14 rounded-full bg-white" />
          </button>

          {/* Reset */}
          <button
            onClick={() => setOverlayTransform(defaultTransform)}
            className="p-3 rounded-full bg-white/10 backdrop-blur-sm"
          >
            <X size={22} className="text-white" />
          </button>
        </div>

        {/* Slide-up Panel */}
        <AnimatePresence>
          {showPanel && (
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25 }}
              className="fixed bottom-0 left-0 right-0 bg-gray-900/95 backdrop-blur-xl rounded-t-3xl p-5 max-h-[70vh] overflow-y-auto"
            >
              <div className="flex justify-between items-center mb-4">
                <div className="flex gap-2">
                  {(['controls', 'camera-filters', 'overlay-filters'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setPanelTab(tab)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${panelTab === tab ? 'bg-emerald-500 text-white' : 'bg-white/10 text-white/70'}`}
                    >
                      {tab === 'controls' ? 'Steuerung' : tab === 'camera-filters' ? 'Kamera' : 'Overlay'}
                    </button>
                  ))}
                </div>
                <button onClick={() => setShowPanel(false)} className="p-1">
                  <X size={18} className="text-white/60" />
                </button>
              </div>

              {panelTab === 'controls' && (
                <div className="space-y-4">
                  <SliderRow label="Transparenz" value={overlayOpacity} min={0} max={100} onChange={v => setOverlayOpacity(v)} />
                  <SliderRow label="Position X" value={overlayTransform.x} min={-200} max={200} onChange={v => setOverlayTransform(p => ({ ...p, x: v }))} />
                  <SliderRow label="Position Y" value={overlayTransform.y} min={-200} max={200} onChange={v => setOverlayTransform(p => ({ ...p, y: v }))} />
                  <SliderRow label="Skalierung" value={overlayTransform.scale * 100} min={10} max={300} onChange={v => setOverlayTransform(p => ({ ...p, scale: v / 100 }))} />
                  <SliderRow label="Rotation" value={overlayTransform.rotate} min={-180} max={180} onChange={v => setOverlayTransform(p => ({ ...p, rotate: v }))} />
                  <div>
                    <p className="text-white/60 text-xs mb-2">Filtermodus</p>
                    <div className="flex gap-2 flex-wrap">
                      {(['normal', 'difference', 'invert', 'edges'] as const).map(m => (
                        <button
                          key={m}
                          onClick={() => setFilterMode(m)}
                          className={`px-3 py-1 rounded-lg text-xs transition-colors ${filterMode === m ? 'bg-emerald-500 text-white' : 'bg-white/10 text-white/70'}`}
                        >
                          {m === 'normal' ? 'Normal' : m === 'difference' ? 'Differenz' : m === 'invert' ? 'Invertiert' : 'Kanten'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {panelTab === 'camera-filters' && (
                <div className="space-y-4">
                  <SliderRow label="Helligkeit" value={cameraFilters.brightness} min={0} max={200} onChange={v => setCameraFilters(p => ({ ...p, brightness: v }))} />
                  <SliderRow label="Kontrast" value={cameraFilters.contrast} min={0} max={200} onChange={v => setCameraFilters(p => ({ ...p, contrast: v }))} />
                  <SliderRow label="Sättigung" value={cameraFilters.saturate} min={0} max={200} onChange={v => setCameraFilters(p => ({ ...p, saturate: v }))} />
                  <SliderRow label="Farbtemperatur" value={cameraFilters.temperature} min={-90} max={90} onChange={v => setCameraFilters(p => ({ ...p, temperature: v }))} />
                  <button onClick={() => setCameraFilters(defaultFilters)} className="text-xs text-white/40 underline">Zurücksetzen</button>
                </div>
              )}

              {panelTab === 'overlay-filters' && (
                <div className="space-y-4">
                  <SliderRow label="Helligkeit" value={overlayFilters.brightness} min={0} max={200} onChange={v => setOverlayFilters(p => ({ ...p, brightness: v }))} />
                  <SliderRow label="Kontrast" value={overlayFilters.contrast} min={0} max={200} onChange={v => setOverlayFilters(p => ({ ...p, contrast: v }))} />
                  <SliderRow label="Sättigung" value={overlayFilters.saturate} min={0} max={200} onChange={v => setOverlayFilters(p => ({ ...p, saturate: v }))} />
                  <SliderRow label="Farbtemperatur" value={overlayFilters.temperature} min={-90} max={90} onChange={v => setOverlayFilters(p => ({ ...p, temperature: v }))} />
                  <button onClick={() => setOverlayFilters(defaultFilters)} className="text-xs text-white/40 underline">Zurücksetzen</button>
                </div>
              )}

              {baseExif?.focalLengthIn35mm && (
                <div className="mt-4 p-3 bg-white/5 rounded-xl">
                  <p className="text-white/40 text-xs">EXIF: {baseExif.focalLengthIn35mm}mm · {baseExif.lensModel || 'Unbekanntes Objektiv'}</p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function SliderRow({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="flex justify-between text-xs text-white/60 mb-1">
        <span>{label}</span>
        <span>{Math.round(value)}</span>
      </div>
      <input
        type="range" min={min} max={max} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-emerald-500"
      />
    </div>
  )
}

// ─── Export helper ────────────────────────────────────────────────────────────

async function exportPair(pair: PhotoPair, label?: string) {
  const [oldImg, newImg] = await Promise.all([
    loadImage(pair.oldPhotoUrl),
    loadImage(pair.newPhotoUrl),
  ])
  const height = Math.min(oldImg.height, newImg.height, 1200)
  const oldW = Math.round((oldImg.width / oldImg.height) * height)
  const newW = Math.round((newImg.width / newImg.height) * height)
  const gap = 16
  const footerH = 40
  const canvas = document.createElement('canvas')
  canvas.width = oldW + gap + newW
  canvas.height = height + footerH
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#0f1117'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(oldImg, 0, 0, oldW, height)
  ctx.drawImage(newImg, oldW + gap, 0, newW, height)
  ctx.fillStyle = 'white'
  ctx.font = '14px system-ui'
  ctx.fillText('Damals', 8, height + 26)
  ctx.fillText('Heute', oldW + gap + 8, height + 26)
  if (label) {
    ctx.textAlign = 'right'
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillText(label, canvas.width - 8, height + 26)
  }
  const a = document.createElement('a')
  a.href = canvas.toDataURL('image/jpeg', 0.9)
  a.download = `rephoto-${Date.now()}.jpg`
  a.click()
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = document.createElement('img')
    img.onload = () => res(img)
    img.onerror = rej
    img.src = src
  })
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<View>('home')
  const [pairs, setPairs] = useState<PhotoPair[]>(loadPairs)
  const [projects, setProjects] = useState<Project[]>(loadProjects)
  const [basePhoto, setBasePhoto] = useState<string>('')
  const [baseExif, setBaseExif] = useState<ExifData | undefined>()
  const [currentProjectId, setCurrentProjectId] = useState<string | undefined>()
  const [selectedPair, setSelectedPair] = useState<PhotoPair | null>(null)
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [showNewProject, setShowNewProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const projectFileInputRef = useRef<HTMLInputElement>(null)

  const openCamera = async (file: File) => {
    const reader = new FileReader()
    reader.onload = async (e) => {
      const url = e.target?.result as string
      setBasePhoto(url)
      setView('camera')
      extractExif(file).then(exif => setBaseExif(exif))
    }
    reader.readAsDataURL(file)
  }

  const handleSavePair = (pair: PhotoPair) => {
    const updated = [pair, ...pairs]
    setPairs(updated)
    savePairs(updated)
    if (pair.projectId) {
      const updatedProjects = projects.map(p =>
        p.id === pair.projectId ? { ...p, pairs: [pair, ...p.pairs] } : p
      )
      setProjects(updatedProjects)
      saveProjects(updatedProjects)
    }
    setView('pair-detail')
    setSelectedPair(pair)
  }

  const deletePair = (id: string) => {
    const updated = pairs.filter(p => p.id !== id)
    setPairs(updated)
    savePairs(updated)
  }

  const createProject = (baseUrl: string, exif?: ExifData) => {
    if (!newProjectName.trim()) return
    const project: Project = {
      id: Date.now().toString(),
      name: newProjectName.trim(),
      basePhotoUrl: baseUrl,
      pairs: [],
      exif,
      createdAt: Date.now(),
    }
    const updated = [project, ...projects]
    setProjects(updated)
    saveProjects(updated)
    setNewProjectName('')
    setShowNewProject(false)
    setCurrentProjectId(project.id)
    setBasePhoto(baseUrl)
    setBaseExif(exif)
    setView('camera')
  }

  return (
    <div className="min-h-screen bg-[#0f1117] text-white">
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) openCamera(f)
          e.target.value = ''
        }}
      />
      <input
        ref={projectFileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async e => {
          const f = e.target.files?.[0]
          if (!f) return
          const reader = new FileReader()
          reader.onload = async (ev) => {
            const url = ev.target?.result as string
            const exif = await extractExif(f)
            createProject(url, exif)
          }
          reader.readAsDataURL(f)
          e.target.value = ''
        }}
      />

      <AnimatePresence mode="wait">
        {/* ── Camera View ── */}
        {view === 'camera' && (
          <motion.div key="camera" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <CameraView
              basePhoto={basePhoto}
              baseExif={baseExif}
              projectId={currentProjectId}
              onSave={handleSavePair}
              onBack={() => {
                setCurrentProjectId(undefined)
                setView('home')
              }}
            />
          </motion.div>
        )}

        {/* ── Pair Detail View ── */}
        {view === 'pair-detail' && selectedPair && (
          <motion.div key="pair-detail" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="min-h-screen">
            <Header title="Ergebnis" onBack={() => setView(selectedPair.projectId ? 'project-detail' : 'gallery')} />
            <div className="pt-16 p-4 space-y-4">
              <BeforeAfterSlider oldUrl={selectedPair.oldPhotoUrl} newUrl={selectedPair.newPhotoUrl} />
              <div className="flex gap-3">
                <button
                  onClick={() => exportPair(selectedPair, new Date(selectedPair.timestamp).toLocaleDateString('de-DE'))}
                  className="flex-1 flex items-center justify-center gap-2 p-3 rounded-xl bg-emerald-500 text-white font-medium"
                >
                  <Download size={18} /> Exportieren
                </button>
                <button
                  onClick={() => {
                    deletePair(selectedPair.id)
                    setView('gallery')
                  }}
                  className="p-3 rounded-xl bg-red-500/20 text-red-400"
                >
                  <Trash2 size={18} />
                </button>
              </div>
              <div className="p-4 bg-white/5 rounded-xl text-sm text-white/60">
                <p>Genauigkeit: <span className="text-white font-medium">{calcAccuracy(selectedPair.overlayTransform)}%</span></p>
                <p>Datum: {new Date(selectedPair.timestamp).toLocaleString('de-DE')}</p>
                {selectedPair.exif?.focalLengthIn35mm && <p>Brennweite: {selectedPair.exif.focalLengthIn35mm}mm</p>}
              </div>
              <button
                onClick={() => {
                  setBasePhoto(selectedPair.oldPhotoUrl)
                  setCurrentProjectId(selectedPair.projectId)
                  setView('camera')
                }}
                className="w-full p-3 rounded-xl bg-white/5 border border-white/10 text-white/70 flex items-center justify-center gap-2"
              >
                <Camera size={16} /> Nochmals aufnehmen
              </button>
            </div>
          </motion.div>
        )}

        {/* ── Gallery View ── */}
        {view === 'gallery' && (
          <motion.div key="gallery" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="min-h-screen">
            <Header title="Galerie" onBack={() => setView('home')} />
            <div className="pt-16 p-4">
              {pairs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-white/40 space-y-3">
                  <Image size={48} strokeWidth={1} />
                  <p>Noch keine Fotos</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {pairs.map(pair => (
                    <button
                      key={pair.id}
                      onClick={() => { setSelectedPair(pair); setView('pair-detail') }}
                      className="aspect-square rounded-xl overflow-hidden relative group"
                    >
                      <img src={pair.newPhotoUrl} className="w-full h-full object-cover" alt="" />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-active:opacity-100 transition-opacity flex items-end p-2">
                        <span className="text-white text-xs">{new Date(pair.timestamp).toLocaleDateString('de-DE')}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* ── Projects View ── */}
        {view === 'projects' && (
          <motion.div key="projects" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="min-h-screen">
            <Header title="Projekte" onBack={() => setView('home')} action={
              <button onClick={() => setShowNewProject(true)} className="p-2 rounded-full bg-emerald-500">
                <Plus size={18} className="text-white" />
              </button>
            } />
            <div className="pt-16 p-4 space-y-3">
              {projects.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-white/40 space-y-3">
                  <FolderOpen size={48} strokeWidth={1} />
                  <p>Noch keine Projekte</p>
                  <button
                    onClick={() => setShowNewProject(true)}
                    className="px-4 py-2 rounded-xl bg-emerald-500 text-white text-sm"
                  >
                    Projekt erstellen
                  </button>
                </div>
              ) : (
                projects.map(project => (
                  <button
                    key={project.id}
                    onClick={() => { setSelectedProject(project); setView('project-detail') }}
                    className="w-full flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10 text-left"
                  >
                    <div className="w-14 h-14 rounded-lg overflow-hidden flex-shrink-0">
                      <img src={project.basePhotoUrl} className="w-full h-full object-cover" alt="" />
                    </div>
                    <div>
                      <p className="font-medium text-white">{project.name}</p>
                      <p className="text-white/40 text-sm">{project.pairs.length} Fotos · {new Date(project.createdAt).toLocaleDateString('de-DE')}</p>
                    </div>
                  </button>
                ))
              )}
            </div>

            {/* New Project Modal */}
            <AnimatePresence>
              {showNewProject && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 bg-black/70 flex items-end z-50"
                  onClick={() => setShowNewProject(false)}
                >
                  <motion.div
                    initial={{ y: '100%' }}
                    animate={{ y: 0 }}
                    exit={{ y: '100%' }}
                    onClick={e => e.stopPropagation()}
                    className="w-full bg-gray-900 rounded-t-3xl p-6 space-y-4"
                  >
                    <h2 className="text-lg font-semibold">Neues Projekt</h2>
                    <input
                      type="text"
                      placeholder="Projektname"
                      value={newProjectName}
                      onChange={e => setNewProjectName(e.target.value)}
                      className="w-full p-3 rounded-xl bg-white/10 border border-white/10 text-white placeholder-white/30 outline-none focus:border-emerald-500"
                    />
                    <button
                      onClick={() => projectFileInputRef.current?.click()}
                      disabled={!newProjectName.trim()}
                      className="w-full p-3 rounded-xl bg-emerald-500 text-white font-medium disabled:opacity-40"
                    >
                      Basis-Foto wählen
                    </button>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}

        {/* ── Project Detail View ── */}
        {view === 'project-detail' && selectedProject && (
          <motion.div key="project-detail" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="min-h-screen">
            <Header
              title={selectedProject.name}
              onBack={() => setView('projects')}
              action={
                <button
                  onClick={() => {
                    setCurrentProjectId(selectedProject.id)
                    setBasePhoto(selectedProject.basePhotoUrl)
                    setBaseExif(selectedProject.exif)
                    setView('camera')
                  }}
                  className="p-2 rounded-full bg-emerald-500"
                >
                  <Plus size={18} className="text-white" />
                </button>
              }
            />
            <div className="pt-16 p-4 space-y-4">
              <div className="w-full aspect-video rounded-xl overflow-hidden">
                <img src={selectedProject.basePhotoUrl} className="w-full h-full object-cover" alt="" />
              </div>
              {selectedProject.pairs.length === 0 ? (
                <div className="flex flex-col items-center py-10 text-white/40 space-y-3">
                  <p>Noch keine Fotos in diesem Projekt</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {selectedProject.pairs.map(pair => (
                    <button
                      key={pair.id}
                      onClick={() => { setSelectedPair(pair); setView('pair-detail') }}
                      className="aspect-square rounded-xl overflow-hidden"
                    >
                      <img src={pair.newPhotoUrl} className="w-full h-full object-cover" alt="" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* ── Home View ── */}
        {view === 'home' && (
          <motion.div key="home" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight">RePhoto</h1>
                <p className="text-white/40 text-xs">Historische Fotos nachstellen</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setView('gallery')} className="p-2.5 rounded-xl bg-white/5 border border-white/10">
                  <Image size={18} className="text-white/70" />
                </button>
                <button onClick={() => setView('projects')} className="p-2.5 rounded-xl bg-white/5 border border-white/10">
                  <FolderOpen size={18} className="text-white/70" />
                </button>
              </div>
            </div>

            {/* Main CTA */}
            <div className="flex-1 flex flex-col items-center justify-center p-6 space-y-4">
              <div className="w-24 h-24 rounded-3xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-4">
                <Camera size={40} className="text-emerald-400" strokeWidth={1.5} />
              </div>
              <h2 className="text-2xl font-bold text-center">Zeitreise starten</h2>
              <p className="text-white/50 text-center text-sm max-w-xs">
                Wähle ein historisches Foto und stelle es am gleichen Ort nach
              </p>

              <button
                onClick={() => {
                  setCurrentProjectId(undefined)
                  fileInputRef.current?.click()
                }}
                className="w-full max-w-sm p-4 rounded-2xl bg-emerald-500 text-white font-semibold text-lg flex items-center justify-center gap-3 active:scale-98 transition-transform"
              >
                <Camera size={22} /> Foto nachstellen
              </button>

              <button
                onClick={() => setView('projects')}
                className="w-full max-w-sm p-4 rounded-2xl bg-white/5 border border-white/10 text-white font-medium flex items-center justify-center gap-3"
              >
                <FolderOpen size={20} /> Projekte verwalten
              </button>
            </div>

            {/* Recent pairs */}
            {pairs.length > 0 && (
              <div className="p-4 pb-8">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-white/60 text-sm font-medium">Zuletzt aufgenommen</p>
                  <button onClick={() => setView('gallery')} className="text-emerald-400 text-xs">Alle</button>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-1">
                  {pairs.slice(0, 8).map(pair => (
                    <button
                      key={pair.id}
                      onClick={() => { setSelectedPair(pair); setView('pair-detail') }}
                      className="flex-shrink-0 w-20 h-20 rounded-xl overflow-hidden"
                    >
                      <img src={pair.newPhotoUrl} className="w-full h-full object-cover" alt="" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Header({ title, onBack, action }: { title: string; onBack: () => void; action?: React.ReactNode }) {
  return (
    <div className="fixed top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-3 bg-[#0f1117]/90 backdrop-blur-xl border-b border-white/5">
      <button onClick={onBack} className="p-2 -ml-2 rounded-xl flex items-center gap-1 text-white/70">
        <ChevronLeft size={20} />
      </button>
      <span className="font-semibold text-white">{title}</span>
      <div className="w-9">{action}</div>
    </div>
  )
}
