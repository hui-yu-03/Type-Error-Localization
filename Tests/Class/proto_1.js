function Counter(start) {
  this.count = start;
}

Counter.prototype.increment = function (n) {
  this.count = this.count + n;
  return this.count;
};

var c = new Counter(0);
var x = c.increment(1);
