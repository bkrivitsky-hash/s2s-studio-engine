/**
 * Stem to Stream Studio engine: TypeScript types for window.S2S.
 *
 * Load dist/studio-engine.js as a classic <script> before your app, then:
 *   const studio = window.S2S.studio.createController();
 *   await studio.init();
 *
 * Times are seconds. A clip plays source time t at song time t + start − offset.
 * MIDI note times (n.t) are source times too. Volumes are dB (−60 = silence).
 */

export type Id = string;

// ------------------------------------------------------------- song model ---

export interface Song {
  app: string;
  version: 1;
  id: Id;
  name: string;
  bpm: number;                       // 20..300, counts quarter notes
  sig: [number, number];             // [beats per bar 1..32, denominator 2|4|8|16]
  gridOffset: number;                // song time of bar 1, seconds
  snap: Snap;                        // timeline snap (a view setting, saved with the song)
  masterDb: number;                  // −60..6
  master: { fx: Effect[]; limiter: Limiter };
  loop: { on: boolean; start: number; end: number };
  tracks: Track[];                   // top to bottom
  clips: Clip[];                     // any order; clip.trackId says where
  sources: Record<Id, Source>;       // audio files and processed versions
  created: number;
  updated: number;
}

export type Snap = 'off' | 'bar' | '1/2' | '1/4' | '1/8' | '1/16';

export interface Track {
  id: Id;
  name: string;
  color: number;                     // 0..7, a palette index
  volumeDb: number;                  // −60..6
  pan: number;                       // −1..1
  mute: boolean;
  solo: boolean;
  fx: Effect[];                      // run in order
  type?: 'midi';                     // instrument track when set; audio track otherwise
  inst?: Instrument;
}

export interface Clip {
  id: Id;
  trackId: Id;
  name: string;
  start: number;                     // song time
  offset: number;                    // source time where the clip starts
  duration: number;
  fadeIn: number;
  fadeOut: number;
  gainDb: number;
  disabled: boolean;
  sourceId: Id | null;               // audio clips; null for MIDI
  versions?: Id[];                   // audio versions (original first) after a vocal tool
  kind?: 'midi';
  notes?: Note[];                    // MIDI clips
}

export interface Note {
  p: number;                         // MIDI pitch 0..127 (60 = C4)
  t: number;                         // source time, seconds
  d: number;                         // length, seconds
  v: number;                         // velocity 1..127
}

export interface Source {
  id: Id;
  name: string;
  type: string;
  duration: number;
  sampleRate: number;
  channels: number;
  demo?: string;
}

export type EffectType = 'eq' | 'comp' | 'reverb' | 'delay' | 'drive';

export interface Effect {
  id: Id;
  type: EffectType;
  on: boolean;
  p: Record<string, number | string>;
}

export interface Limiter {
  on: boolean;
  driveDb: number;                   // −24..24
  ceilingDb: number;                 // −6..0 dBTP
  releaseMs: number;                 // 10..1000
}

export type InstrumentType = 'synth' | 'fm' | 'organ' | 'drums';

export interface Instrument {
  type: InstrumentType;
  preset: string;                    // a preset id, '' when edited by hand
  p: Record<string, number | string | boolean>;
}

// ---------------------------------------------------------------- schemas ---

/** A parameter: a slider (min/max/step, log scale when log) or a pick list (options). */
export interface ParamSpec {
  label: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;                     // 'Hz' | 'dB' | 'dBTP' | 'ms' | 's' | '%' | ':1' | ''
  def: number | string | boolean;
  log?: boolean;
  options?: string[];
  offAt?: number;                    // this value means "off" (show 'Off')
}

export interface FxSpec { name: string; params: Record<string, ParamSpec> }
export interface InstrumentSpec { name: string; params: Record<string, ParamSpec> }
export interface Preset { id: string; name: string; type: InstrumentType; p: Record<string, number | string | boolean> }

// ----------------------------------------------------------------- events ---

export type ChangeKind =
  | 'name' | 'mix' | 'fx' | 'fxchain' | 'loop' | 'song' | 'arrange' | 'notes'
  | 'all' | 'open' | 'snap' | 'marks' | 'key';

export type StudioEvent =
  | { type: 'change'; version: number; kind: ChangeKind; live?: boolean; fit?: boolean }
  | { type: 'select'; version: number }
  | { type: 'transport'; version: number }
  | { type: 'save'; version: number; state: SaveState }
  | { type: 'busy'; version: number; job: string | null; done?: string }
  | { type: 'progress'; version: number; job: string | null; value: number }
  | { type: 'message'; version: number; text: string; tone: 'info' | 'success' | 'warn' | 'error'; ms: number }
  | { type: 'midi'; version: number; name: string };

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'nostore';

export interface Levels {
  left: number;                      // linear peak since the last call, 0..1+
  right: number;
  tracks: Record<Id, number>;
  limiterDb: number;                 // gain reduction, ≤ 0
  comps: Record<Id, number>;         // compressor gain reduction by effect id, ≤ 0
}

export interface Frame { playing: boolean; position: number; levels: Levels }

/** A drag: update() while the pointer moves (song changes live), end() records one undo step. */
export interface DragSession<A extends unknown[]> {
  update(...args: A): void;
  end(): boolean;                    // true when something changed
  cancel(): void;                    // puts everything back
}

export interface Check { tone: 'pass' | 'warn' | 'fail' | 'info'; text: string }
export interface OutFile { name: string; blob: Blob }

export interface Analysis {
  sampleRate: number; channels: number; frames: number; duration: number;
  integrated: number; momentaryMax: number; shortTermMax: number; loudnessRange: number;
  samplePeakDb: number; truePeakDb: number; oversampling: number;
  clipEvents: number; clippedSamples: number; leadingSilence: number; trailingSilence: number;
  tailLevelDb: number; correlation: number; dcOffsetDb: number;
}

export interface ExportOptions {
  range?: 'song' | 'loop';           // default 'song' (includes reverb/delay tails)
  bits?: 16 | 24 | 32;               // default 24
  rate?: 44100 | 48000;              // default 48000
  save?: boolean;                    // default true: download the file
}

export interface ToolResult { text: string; [more: string]: unknown }

export interface SongListItem { id: Id; name: string; updated: number; tracks: number; current: boolean }

export interface Peaks {
  sampleRate: number;
  levels: { block: number; max: Float32Array; rms: Float32Array }[];
}

// ------------------------------------------------------------- controller ---

export interface StudioController {
  // ---- state (read freely; change only through the methods below) ----
  readonly song: Song;               // mutable, owned by the controller; never freeze or clone-and-replace it
  readonly selection: { clips: Id[]; track: Id | null };   // same object until it changes
  readonly position: number;         // playhead, seconds
  readonly playing: boolean;
  readonly metronome: boolean;
  readonly version: number;
  readonly saveState: SaveState;
  readonly storage: 'unknown' | 'browser' | 'none';
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly busy: string | null;      // running tool: 'grid' | 'clean' | 'timing' | 'pitch' | 'melody' | 'loudness'
  readonly progress: number;         // 0..1 of the running tool
  readonly results: Record<string, string>;   // last result line per tool
  readonly marks: Record<Id, { t: number; ok: boolean }[]>;   // timing check ticks (song time)
  readonly detectedKey: { key: string; mode: string; name: string; confidence: number; tuningCents: number } | null;
  readonly limiterNote: string;
  readonly limiterMode: true | false | null;  // precise | basic fallback | still loading
  readonly sampleRate: number | null;
  readonly midiInput: string | null; // connected keyboard name
  readonly target: number;           // last loudness target, LUFS
  readonly buffers: Record<Id, AudioBuffer>;
  readonly peaks: Record<Id, Peaks>;

  // ---- events and lifecycle ----
  subscribe(fn: (e: StudioEvent) => void): () => void;
  getVersion(): number;              // for useSyncExternalStore
  init(): Promise<StudioController>; // storage + last song (or the demo); call once
  frame(): Frame;                    // once per animation frame; the only reader of the meters
  message(text: string, tone?: 'info' | 'success' | 'warn' | 'error', ms?: number): void;

  // ---- editing and history ----
  edit<T>(fn: (song: Song) => T | false, kind?: ChangeKind): T | false;
  commit(before: string, kind?: ChangeKind): void;
  snapshot(): string;
  gestureStart(): void;              // pointerdown on a slider or knob
  gestureEnd(kind?: ChangeKind): boolean;   // pointerup: one undo step
  undo(): boolean;
  redo(): boolean;

  // ---- songs and files ----
  newSong(): Song;
  openDemo(): Promise<Song>;
  listSongs(): Promise<SongListItem[]>;
  openSong(id: Id): Promise<{ song: Song; missing: number }>;
  deleteSong(id: Id): Promise<boolean>;
  saveNow(): Promise<boolean>;
  saveSongFile(o?: { save?: boolean }): Promise<{ file: OutFile; how: 'saved' | 'started' | null }>;
  openSongFile(file: Blob): Promise<{ song: Song; missing: number }>;
  saveFile(name: string, blob: Blob): Promise<'saved' | 'started'>;
  importFiles(files: FileList | File[], o?: { at?: number; trackId?: Id }): Promise<{ added: Id[]; failed: string[] }>;
  exportInfo(): { songEnd: number; hasClips: boolean; hasLoop: boolean; loop: { start: number; end: number }; hasMidi: boolean; defaultRate: 44100 | 48000; missingAudio: number };
  exportMix(o?: ExportOptions, onProgress?: (f: number) => void): Promise<{ file: OutFile; how: 'saved' | 'started' | null; analysis: Analysis; peak: number; limiter: 'precise' | 'basic'; checks: Check[] }>;
  exportStems(o?: ExportOptions, onProgress?: (f: number) => void): Promise<{ file: OutFile; how: 'saved' | 'started' | null; count: number; checks: Check[] }>;
  exportMidi(o?: { save?: boolean }): Promise<{ file: OutFile; how?: 'saved' | 'started'; tracks: number; notes: number; checks: Check[] }>;

  // ---- selection ----
  select(ids: Id[]): void;
  toggleSelect(id: Id): void;
  selectAll(): void;
  selectTrack(id: Id | null): void;
  selectedClips(): Clip[];

  // ---- transport and song settings ----
  play(): void;                      // call from a click or key press (browsers need a gesture for audio)
  pause(): void;
  togglePlay(): void;
  seek(t: number): void;
  toggleLoop(): void;
  setLoop(o: { start?: number; end?: number; on?: boolean }): void;
  setMetronome(on: boolean): void;
  toggleMetronome(): void;
  tapTempo(): { bpm: number | null; taps: number };
  alignGridToPlayhead(): void;
  setBpm(bpm: number): boolean | undefined;
  setTimeSignature(num: number, den: 2 | 4 | 8 | 16): unknown;
  setSnap(snap: Snap): void;
  renameSong(name: string): unknown;

  // ---- clips ----
  splitAtPlayhead(): Id[];
  duplicateSelected(): Id[];
  deleteSelected(): boolean;
  toggleDisabled(): boolean;
  clipGain(deltaDb: number): number | null;
  setClipGain(id: Id, db: number): unknown;
  renameClip(id: Id, name: string): unknown;
  nudge(dir: -1 | 1, fine?: boolean): boolean;
  /** Move the selection (or just id): update(deltaSeconds from drag start, laneTrackId?, free?). */
  dragClips(id: Id, o?: { free?: boolean }): DragSession<[number, (Id | null)?, boolean?]>;
  /** Trim an edge to a song time: update(songTime, free?). */
  dragTrim(id: Id, edge: 'start' | 'end'): DragSession<[number, boolean?]>;
  /** Fade length in seconds: update(seconds). */
  dragFade(id: Id, which: 'in' | 'out'): DragSession<[number]>;
  /** Loop on the ruler: 'new' from t0, 'start' / 'end' handles, 'move' grabbed at t0. update(songTime, free?). */
  dragLoop(mode: 'new' | 'start' | 'end' | 'move', t0?: number): DragSession<[number, boolean?]>;

  // ---- tracks and mix ----
  addTrack(o?: { name?: string }): Id;
  addInstrumentTrack(presetId: string): { trackId: Id; clipId: Id };
  deleteTrack(id: Id): boolean;
  renameTrack(id: Id, name: string): unknown;
  setTrackColor(id: Id, color?: number): unknown;   // no color: next in the palette
  moveTrack(id: Id, dir: -1 | 1): unknown;
  toggleMute(id: Id): unknown;
  toggleSolo(id: Id): unknown;
  setVolume(id: Id, db: number): unknown;           // live inside gestureStart/gestureEnd
  setPan(id: Id, pan: number): unknown;
  setMasterDb(db: number): unknown;

  // ---- effects and instruments ----
  fxList(target: Id | 'master'): Effect[];
  addFx(target: Id | 'master', type: EffectType): Id | false;
  removeFx(fxId: Id): unknown;
  moveFx(fxId: Id, dir: -1 | 1): unknown;
  toggleFx(fxId: Id): unknown;
  setFxParam(fxId: Id, key: string, value: number | string): unknown;
  toggleLimiter(): unknown;
  setLimiterParam(key: 'driveDb' | 'ceilingDb' | 'releaseMs', value: number): unknown;
  matchLoudness(lufs: -14 | -11 | -9 | number, onProgress?: (f: number) => void): Promise<{ integrated: number; truePeakDb: number; driveDb: number; text: string }>;
  eqCurve(params: Record<string, number | string>, freqs: number[]): number[];   // dB
  setPreset(trackId: Id, presetId: string): unknown;
  setInstParam(trackId: Id, key: string, value: number | string | boolean): unknown;
  instParams(trackId: Id): Record<string, number | string | boolean> | null;

  // ---- vocal tools (one at a time; each resolves {text, ...} and sets results[tool]) ----
  detectGrid(): Promise<ToolResult & { bpm: number; barOffset: number; confidence: number }>;
  scaleTempo(f: 0.5 | 2): unknown;
  cleanUp(clipId: Id, o?: { preset?: 'vocal' | 'mix' | 'gentle'; steps?: Partial<Record<'declick' | 'lowEnd' | 'denoise' | 'deshimmer' | 'deess', boolean>> }): Promise<ToolResult>;
  checkTiming(clipId: Id, o?: { subdivision?: 8 | 16 }): Promise<ToolResult>;
  tighten(clipId: Id, o?: { strength?: number; subdivision?: 8 | 16 }): Promise<ToolResult>;
  lineUp(clipId: Id): Promise<ToolResult & { offset: number }>;
  detectKey(clipId?: Id): Promise<ToolResult>;
  tune(clipId: Id, o?: { key?: 'auto' | string; mode?: 'auto' | 'major' | 'minor' | 'chromatic'; speed?: number; strength?: number; vibrato?: number }): Promise<ToolResult>;
  melodyToMidi(clipId: Id, presetId?: string): Promise<ToolResult & { trackId?: Id; clipId?: Id; notes: number }>;
  versionsOf(clipId: Id): { id: Id; label: string; current: boolean }[];
  useVersion(clipId: Id, sourceId: Id): unknown;

  // ---- MIDI ----
  newMidiClip(trackId: Id, at?: number, length?: number): Id | null;
  setNotes(clipId: Id, notes: Note[]): unknown;      // live inside a gesture
  addNote(clipId: Id, pitch: number, songTime: number, o?: { grid?: string; free?: boolean; length?: number; velocity?: number }): number;
  deleteNotes(clipId: Id, indexes: number[]): unknown;
  transposeNotes(clipId: Id, indexes: number[] | null, semitones: number): unknown;
  moveNotes(clipId: Id, indexes: number[] | null, seconds: number): unknown;
  setVelocity(clipId: Id, indexes: number[] | null, v: number): unknown;
  duplicateNotes(clipId: Id, indexes: number[], grid?: string): number[];
  quantize(clipId: Id, indexes: number[] | null, grid?: string, strength?: number): unknown;
  /** 'move': update(dtSeconds, dSemitones, free?); 'length': update(dtSeconds, free?); 'velocity': update(v). */
  dragNotes(clipId: Id, indexes: number[] | null, mode: 'move' | 'length' | 'velocity', o?: { grid?: string }): DragSession<unknown[]>;
  noteStep(grid?: string): number;                   // seconds per grid step, e.g. '1/16'
  snapNote(songTime: number, grid?: string, floor?: boolean): number;
  audition(trackId: Id, pitch: number, velocity?: number, duration?: number): void;
  liveNote(trackId: Id, pitch: number, velocity: number): void;   // 0 = note off
  connectMidiInput(target?: Id | (() => Id | null)): Promise<{ name: string }>;

  // ---- drawing and status ----
  waveform(clipId: Id, columns: number, from?: number, to?: number): { max: Float32Array; rms: Float32Array } | null;
  noteBars(clipId: Id): { lo: number; hi: number; notes: { i: number; p: number; start: number; end: number; v: number }[] } | null;
  summary(): { tracks: number; length: number; selected: number; demo: boolean; text: string };

  // ---- underneath ----
  readonly core: StudioCore;
  readonly engine: unknown;
  presetForProgram(program: number | null, isDrums: boolean): string | null;
  readonly schemas: {
    fx: Record<EffectType, FxSpec>;
    limiter: Record<'driveDb' | 'ceilingDb' | 'releaseMs', ParamSpec>;
    instruments: Record<InstrumentType, InstrumentSpec>;
    presets: Preset[];
    syncLabels: Record<string, string>;
    targets: { lufs: number; label: string }[];
    noteGrids: [string, string][];
    noteNames: string[];
    snaps: Snap[];
    denominators: number[];
    colors: number;
    shortcuts: [string, string][];
  };
}

/** Pure helpers on the song, for drawing and hit-testing. */
export interface StudioCore {
  FLOOR_DB: number; MAX_DB: number; MIN_CLIP: number; MIN_LOOP: number; MIN_NOTE: number; COLORS: number;
  quarterSec(song: Song): number;
  beatSec(song: Song): number;
  barSec(song: Song): number;
  snapStep(song: Song, snap: string): number;
  snapTime(song: Song, t: number, snap?: string): number;
  toBBT(song: Song, t: number): { bar: number; beat: number; sub: number };
  fmtBBT(song: Song, t: number): string;            // '5.1.1'
  fmtClock(t: number): string;                      // '0:12.345'
  clipEnd(c: Clip): number;
  songEnd(song: Song): number;
  fadeGain(c: Clip, tInClip: number): number;
  noteSongTime(c: Clip, n: Note): number;
  getTrack(song: Song, id: Id): Track | undefined;
  getClip(song: Song, id: Id): Clip | undefined;
  trackIndex(song: Song, id: Id): number;
  isMidiTrack(t: Track): boolean;
  isMidiClip(c: Clip): boolean;
  trackAudible(song: Song, t: Track): boolean;
  dbToGain(db: number): number;
  gainToDb(g: number): number;
  clamp(v: number, lo: number, hi: number): number;
  [more: string]: unknown;
}

declare global {
  interface Window {
    S2S: {
      studio: {
        createController(opts?: { initialSong?: 'last' | 'demo' | 'empty'; store?: null; historyLimit?: number }): StudioController;
        core: StudioCore;
        synth: { noteName(pitch: number): string; [more: string]: unknown };
        [more: string]: unknown;
      };
      audio: { analyzeAsync(channels: Float32Array[], sampleRate: number, onProgress?: (f: number) => void): Promise<Analysis> };
    };
  }
}
