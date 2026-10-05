/** Keyboard state and mouse look. Mouse only moves the camera while the pointer is locked. */
export class Input {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();
  lookX = 0;
  lookY = 0;
  zoom = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.locked) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked) this.keys.clear();
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (this.locked) this.zoom += Math.sign(e.deltaY);
      },
      { passive: true },
    );
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  lock(): void {
    void this.canvas.requestPointerLock();
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  axis(negative: string, positive: string): number {
    return (this.down(positive) ? 1 : 0) - (this.down(negative) ? 1 : 0);
  }

  /** True once per key press. */
  consume(code: string): boolean {
    return this.pressed.delete(code);
  }

  endFrame(): void {
    this.lookX = 0;
    this.lookY = 0;
    this.zoom = 0;
    this.pressed.clear();
  }
}
