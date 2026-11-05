class Point {
  move(x, y) {
    return x + y;
  }
}

class Line {
  length(a, b) {
    return a - b;
  }
}

const p = new Point();
const l = new Line();
p = new Line();