import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ThemeStore } from '../../core/state/theme.store';
import { ReducedMotionService } from '../../core/a11y/reduced-motion';
import { AURORA_PARTICLE_COLORS, resolveTheme } from '../../core/config/palette';

/** Particle count and the world-space box they drift inside. */
const PARTICLE_COUNT = 150;
const BOX = { x: 22, y: 14, z: 12 } as const;
/** World-space particle radius, before perspective size attenuation. */
const PARTICLE_SIZE = 0.055;
/** Camera distance along +Z. Box depth is 12, so this never divides by ~0. */
const CAMERA_Z = 16;
/** Radians per second the field rotates about Y. */
const SPIN_Y = 0.018;
/**
 * Retina is capped at 1 — this is a blurred ambient field, not content, and
 * every extra DPR step multiplies both the cleared area and the fill cost.
 */
const MAX_DPR = 1;
/**
 * The field is redrawn at 30fps, not display rate. It spins at 0.018 rad/s,
 * so a 33ms step is imperceptible while halving the per-second draw cost.
 */
const FRAME_INTERVAL = 1 / 30;
/**
 * Depth alpha is quantised into this many steps. Particles sharing a colour
 * and a step fill as one path, which turns hundreds of `fill()` calls per
 * frame into at most `colours x ALPHA_STEPS` of them.
 */
const ALPHA_STEPS = 5;
const TAU = Math.PI * 2;

interface Particle {
  x: number;
  y: number;
  z: number;
  /** Index into `colors`, so particles can be binned by colour when drawing. */
  colorIndex: number;
}

/**
 * The live electric aurora every glass surface floats over.
 *
 * Two stacked layers:
 *   1. A CSS layer of blurred, slowly drifting radial gradients. This is
 *      always present and is also the complete reduced-motion fallback.
 *   2. A hand-rolled 2D-canvas particle field projected in perspective —
 *      the same idea as the react-three-fiber field in the design spec,
 *      minus a 600kB WebGL dependency for a background nobody interacts with.
 *
 * The layer never intercepts input (`pointer-events: none`) and its render
 * loop stops entirely when the tab is hidden or the user prefers reduced
 * motion.
 */
@Component({
  selector: 'app-aurora-background',
  standalone: true,
  templateUrl: './aurora-background.component.html',
  styleUrl: './aurora-background.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
})
export class AuroraBackgroundComponent {
  private readonly themeStore = inject(ThemeStore);
  private readonly reducedMotion = inject(ReducedMotionService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  protected readonly reduced = this.reducedMotion.prefersReduced;
  /** Drives the 900ms opacity fade-in once the first frame has painted. */
  protected readonly ready = signal(false);

  private particles: Particle[] = [];
  /** Active palette; particles index into it rather than copying strings. */
  private colors: readonly string[] = [];
  /**
   * Draw bins, indexed `colorIndex * ALPHA_STEPS + alphaStep`. Each holds a
   * flat run of `sx, sy, radius` triples and is emptied — not reallocated —
   * at the top of every frame, so steady-state drawing allocates nothing.
   */
  private bins: number[][] = [];
  private frameHandle = 0;
  private running = false;
  private lastTime = 0;
  private elapsed = 0;
  /** Time banked since the last draw, against FRAME_INTERVAL. */
  private sinceDraw = 0;
  private rotationY = 0;
  /** Field offset, lerped toward the pointer so the aurora drifts with it. */
  private offsetX = 0;
  private offsetY = 0;
  private targetX = 0;
  private targetY = 0;
  private dpr = 1;

  constructor() {
    afterNextRender(() => this.setup());

    // Re-tint the field when the theme flips. Dark mode gets the full
    // five-colour electric ramp; light mode gets three, at lower opacity.
    effect(() => {
      const theme = resolveTheme(this.themeStore.mode());
      if (this.particles.length) {
        this.recolor(theme);
      }
    });

    // Reduced motion can be toggled mid-session — stop the loop if so.
    effect(() => {
      if (this.reducedMotion.prefersReduced()) {
        this.stop();
      }
    });
  }

  private setup(): void {
    if (this.reducedMotion.prefersReduced()) {
      return;
    }
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }

    this.seed();
    this.resize();

    const onResize = () => this.resize();
    const onPointerMove = (event: PointerEvent) => {
      // Normalised to [-1, 1], then scaled the way the spec's r3f field does.
      const nx = (event.clientX / window.innerWidth) * 2 - 1;
      const ny = -((event.clientY / window.innerHeight) * 2 - 1);
      this.targetX = nx * 0.35;
      this.targetY = ny * 0.2;
    };
    const onVisibility = () => (document.hidden ? this.stop() : this.start());

    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);

    this.destroyRef.onDestroy(() => {
      this.stop();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('visibilitychange', onVisibility);
    });

    this.start();
  }

  private seed(): void {
    this.setPalette(resolveTheme(this.themeStore.mode()));
    this.particles = Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      x: (Math.random() - 0.5) * BOX.x,
      y: (Math.random() - 0.5) * BOX.y,
      z: (Math.random() - 0.5) * BOX.z,
      colorIndex: i % this.colors.length,
    }));
  }

  private recolor(theme: 'light' | 'dark'): void {
    const previous = this.colors.length;
    this.setPalette(theme);
    // Light and dark carry different palette lengths, so the stripe has to be
    // reassigned rather than left pointing past the end of the shorter one.
    if (previous !== this.colors.length) {
      this.particles.forEach((p, i) => (p.colorIndex = i % this.colors.length));
    }
  }

  /** Swaps the palette and resizes the bin table to match its length. */
  private setPalette(theme: 'light' | 'dark'): void {
    this.colors = AURORA_PARTICLE_COLORS[theme];
    const needed = this.colors.length * ALPHA_STEPS;
    if (this.bins.length !== needed) {
      this.bins = Array.from({ length: needed }, () => []);
    }
  }

  private resize(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.floor(window.innerWidth * this.dpr);
    canvas.height = Math.floor(window.innerHeight * this.dpr);
  }

  private start(): void {
    if (this.running || this.reducedMotion.prefersReduced() || document.hidden) {
      return;
    }
    this.running = true;
    this.lastTime = performance.now();
    this.frameHandle = requestAnimationFrame((t) => this.frame(t));
  }

  private stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  private frame(now: number): void {
    if (!this.running) {
      return;
    }
    // Clamped so a backgrounded-then-restored tab doesn't jump the field.
    const delta = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;
    this.sinceDraw += delta;

    // Below the 30fps budget there is nothing to do but re-arm. The rAF
    // callback itself is cheap; the draw it guards is not.
    if (this.sinceDraw < FRAME_INTERVAL) {
      this.frameHandle = requestAnimationFrame((t) => this.frame(t));
      return;
    }

    const step = this.sinceDraw;
    this.sinceDraw = 0;
    this.elapsed += step;

    this.rotationY += step * SPIN_Y;
    const rotationX = Math.sin(this.elapsed * 0.05) * 0.06;
    // Time-based rather than per-frame, so halving the draw rate doesn't
    // halve how fast the field chases the pointer. 1.2/s matches the old
    // 0.02-per-frame constant at 60fps.
    const chase = Math.min(1, step * 1.2);
    this.offsetX += (this.targetX - this.offsetX) * chase;
    this.offsetY += (this.targetY - this.offsetY) * chase;

    this.draw(this.rotationY, rotationX);

    if (!this.ready()) {
      this.ready.set(true);
    }
    this.frameHandle = requestAnimationFrame((t) => this.frame(t));
  }

  private draw(rotY: number, rotX: number): void {
    const canvas = this.canvasRef()?.nativeElement;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) {
      return;
    }

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    // Focal length in device pixels — keeps the field the same apparent size
    // regardless of viewport, which stops it looking sparse on wide monitors.
    const focal = Math.min(w, h) * 0.9;
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const sinX = Math.sin(rotX);
    const cosX = Math.cos(rotX);

    for (const bin of this.bins) {
      bin.length = 0;
    }

    // Pass 1 — project every particle and bin it by colour and depth. No
    // canvas state is touched here, so nothing forces a flush per particle.
    for (const p of this.particles) {
      // Rotate about Y, then X.
      const x1 = p.x * cosY + p.z * sinY;
      const z1 = p.z * cosY - p.x * sinY;
      const y2 = p.y * cosX - z1 * sinX;
      const z2 = z1 * cosX + p.y * sinX;

      const depth = CAMERA_Z - z2;
      const scale = focal / depth;
      const sx = (x1 + this.offsetX) * scale + cx;
      const sy = -(y2 + this.offsetY) * scale + cy;
      const radius = PARTICLE_SIZE * scale;

      if (sx < -radius || sx > w + radius || sy < -radius || sy > h + radius) {
        continue;
      }

      // Nearer particles read brighter — the depth cue that sells the box
      // as a volume rather than a flat scatter. Quantised so particles at a
      // similar depth can share one fill.
      const alpha = Math.min(1, Math.max(0, (CAMERA_Z + BOX.z / 2 - depth) / BOX.z));
      const step = Math.min(ALPHA_STEPS - 1, Math.floor(alpha * ALPHA_STEPS));
      const bin = this.bins[p.colorIndex * ALPHA_STEPS + step];
      bin.push(sx, sy, radius);
    }

    // Pass 2 — one path, and one fill, per non-empty bin.
    for (let b = 0; b < this.bins.length; b++) {
      const bin = this.bins[b];
      if (!bin.length) {
        continue;
      }
      ctx.globalAlpha = ((b % ALPHA_STEPS) + 1) / ALPHA_STEPS;
      ctx.fillStyle = this.colors[Math.floor(b / ALPHA_STEPS)];
      ctx.beginPath();
      for (let i = 0; i < bin.length; i += 3) {
        // moveTo before each arc, or consecutive circles get joined by a
        // straight segment from the previous subpath's end point.
        ctx.moveTo(bin[i] + bin[i + 2], bin[i + 1]);
        ctx.arc(bin[i], bin[i + 1], bin[i + 2], 0, TAU);
      }
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }
}
