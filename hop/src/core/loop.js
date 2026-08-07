// Fixed-timestep game loop.
//
// Physics runs at a constant rate no matter what the display does, so the car
// feels identical at 30fps and at 144fps. Rendering gets an interpolation
// factor so motion stays smooth between physics steps.

const STEP = 1 / 120;        // physics tick, seconds
const MAX_STEPS = 6;         // spiral-of-death guard: never simulate more than this per frame
const MAX_FRAME = 0.25;      // clamp huge gaps (tab was backgrounded)

export class Loop {
  /**
   * @param {(dt:number)=>void} update  fixed-step simulation
   * @param {(alpha:number, frameDt:number)=>void} render
   */
  constructor(update, render) {
    this.update = update;
    this.render = render;
    this.accumulator = 0;
    this.last = 0;
    this.running = false;
    this.frameId = 0;
    this.fps = 60;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.accumulator = 0;
    this.frameId = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this.frameId) cancelAnimationFrame(this.frameId);
    this.frameId = 0;
  }

  _tick(now) {
    if (!this.running) return;
    this.frameId = requestAnimationFrame(this._tick);

    let frameDt = (now - this.last) / 1000;
    this.last = now;
    if (!(frameDt > 0)) frameDt = 0;
    if (frameDt > MAX_FRAME) frameDt = MAX_FRAME;

    this._fpsAccum += frameDt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= STEP && steps < MAX_STEPS) {
      this.update(STEP);
      this.accumulator -= STEP;
      steps++;
    }
    // If we blew the budget, drop the backlog rather than falling further behind.
    if (steps === MAX_STEPS) this.accumulator = 0;

    this.render(this.accumulator / STEP, frameDt);
  }
}

export { STEP };
