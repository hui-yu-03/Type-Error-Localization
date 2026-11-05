export class Vec2 {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  scale(factor) {
    this.x = this.x * factor;
    this.y = this.y * factor;
  }
}

export function makeVec(a, b) {
  return new Vec2(a, b);
}
